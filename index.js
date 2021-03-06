var AWS = require('aws-sdk');
var Dyno = require('dyno');
var queue = require('queue-async');
var crypto = require('crypto');
var AgentKeepAlive = require('agentkeepalive');
var fs = require('fs');

module.exports.replicate = replicate;
module.exports.backup = incrementalBackup;
module.exports.snapshot = require('./s3-snapshot');
module.exports.lambdaenvReplicate = LambdaEnv(replicate);
module.exports.lambdaenvBackup = LambdaEnv(incrementalBackup);
module.exports.agent = new AgentKeepAlive.HttpsAgent({
    keepAlive: true,
    maxSockets: Math.ceil(require('os').cpus().length * 16),
    keepAliveTimeout: 60000
});


function LambdaEnv(service) {
    return function loadEnvironment(event, context) {
        console.log('Start time: %s', (new Date()).toISOString());
        console.log('Event md5: %s', crypto.createHash('md5').update(JSON.stringify(event)).digest('hex'));
        // for more debugging
        console.log('event = ', JSON.stringify(event, null, 2));
        console.log('context = ', JSON.stringify(context, null, 2));
        console.log('Table :', process.env.ReplicaTable);
        console.log('Region :', process.env.region);
        console.log('Replica Endpoint: %s', process.env.ReplicaEndpoint);
        var callback = context.done.bind(context);
        if (fs.existsSync('config.env')) {
            require('dotenv').config({path: 'config.env'})
            console.log('Loaded environment from config.env');
        }
        service.call(context, event, callback);
    };
}

function replicate(event, callback) {
    var replicaConfig = {
        accessKeyId: process.env.ReplicaAccessKeyId || undefined,
        secretAccessKey: process.env.ReplicaSecretAccessKey || undefined,
        table: process.env.ReplicaTable,
        region: process.env.ReplicaRegion,
        maxRetries: 1000,
        httpOptions: {
            timeout: 750,
            agent: module.exports.agent
        }
    };
    console.log('Table :' + process.env.ReplicaTable);
    console.log('Region :' + replicaConfig.region);
    console.log('Replica Endpoint : ' + process.env.ReplicaEndpoint);
    console.log('Access Key Id : ' + replicaConfig.accessKeyId);
    console.log('Secret Access Key: ' + replicaConfig.secretAccessKey);
    if (process.env.ReplicaEndpoint) replicaConfig.endpoint = process.env.ReplicaEndpoint;
    var replica = new Dyno(replicaConfig);

    var keyAttrs = Object.keys(event.Records[0].dynamodb.Keys);

    var allRecords = event.Records.reduce(function (allRecords, change) {
        var id = JSON.stringify(change.dynamodb.Keys);
        allRecords[id] = allRecords[id] || [];
        allRecords[id].push(change);
        console.log('Key Id : ' + id);
        console.log('Record : ' + JSON.stringify(allRecords));
        return allRecords;
    }, {});

    var params = {RequestItems: {}};
    params.RequestItems[process.env.ReplicaTable] = Object.keys(allRecords).map(function (key) {
        var change = allRecords[key].pop();
        if (change.eventName === 'INSERT' || change.eventName === 'MODIFY') {
            console.log("Event Name : " + change.eventName);
            return {
                PutRequest: {Item: Dyno.deserialize(JSON.stringify(change.dynamodb.NewImage))}
            };
        } else if (change.eventName === 'REMOVE') {
            console.log("Event Name : " + change.eventName);
            return {
                DeleteRequest: {Key: Dyno.deserialize(JSON.stringify(change.dynamodb.Keys))}
            }
        }
    });

    (function batchWrite(requestSet, attempts) {
        requestSet.forEach(function (req) {
            if (req) req.on('retry', function (res) {
                if (!res.error || !res.httpResponse || !res.httpResponse.headers) return;
                if (res.error.name === 'TimeoutError') res.error.retryable = true;
                console.log(
                    '[failed-request] %s | request-id: %s | crc32: %s | items: %j',
                    res.error.message,
                    res.httpResponse.headers['x-amzn-requestid'],
                    res.httpResponse.headers['x-amz-crc32'],
                    req.params.RequestItems[process.env.ReplicaTable].map(function (req) {
                        if (req.DeleteRequest) return req.DeleteRequest.Key;
                        if (req.PutRequest) return keyAttrs.reduce(function (key, k) {
                            key[k] = req.PutRequest.Item[k];
                            return key;
                        }, {});
                    })
                );
            });
        });

        requestSet.sendAll(100, function (errs, responses, unprocessed) {
            attempts++;

            if (errs) {
                var messages = errs
                    .filter(function (err) {
                        return !!err;
                    })
                    .map(function (err) {
                        return err.message;
                    })
                    .join(' | ');
                console.log('[error] %s', messages);
                return callback(errs);
            }

            if (unprocessed) {
                console.log('[retry] attempt %s contained unprocessed items', attempts);
                return setTimeout(batchWrite, Math.pow(2, attempts), unprocessed, attempts);
            }

            callback();
        });
    })(replica.batchWriteItemRequests(params), 0);
}

function incrementalBackup(event, callback) {
    console.log('Table *:' + process.env.ReplicaTable);
    console.log('Region *:' + process.env.region);
    console.log('Replica Endpoint *: ' + process.env.ReplicaEndpoint);
    var allRecords = event.Records.reduce(function (allRecords, action) {
        var id = JSON.stringify(action.dynamodb.Keys);

        allRecords[id] = allRecords[id] || [];
        allRecords[id].push(action);
        return allRecords;
    }, {});

    var params = {
        maxRetries: 1000,
        httpOptions: {
            timeout: 1000,
            agent: module.exports.agent
        }
    };

    if (process.env.BackupRegion) params.region = process.env.BackupRegion;
    console.log('process.env.BackupRegion *: ' + process.env.BackupRegion);
    var s3 = new AWS.S3(params);
    var q = queue();

    Object.keys(allRecords).forEach(function (key) {
        q.defer(backupRecord, allRecords[key]);
    });

    q.awaitAll(function (err) {
        if (err) throw err;
        callback();
    });

    function backupRecord(changes, callback) {
        var q = queue(1);

        changes.forEach(function (change) {
            q.defer(function (next) {
                var id = crypto.createHash('md5')
                    .update(JSON.stringify(change.dynamodb.Keys))
                    .digest('hex');

                var table = change.eventSourceARN.split('/')[1];

                var params = {
                    Bucket: process.env.BackupBucket,
                    Key: [process.env.BackupPrefix, table, id].join('/')
                };

                var req = change.eventName === 'REMOVE' ? 'deleteObject' : 'putObject';
                if (req === 'putObject') params.Body = JSON.stringify(change.dynamodb.NewImage);
                console.log('New Image : ' + JSON.stringify(change.dynamodb.NewImage))
                s3[req](params, function (err) {
                    if (err) console.log(
                        '[error] %s | %s s3://%s/%s | %s',
                        JSON.stringify(change.dynamodb.Keys),
                        req, params.Bucket, params.Key,
                        err.message
                    );
                    next(err);
                }).on('retry', function (res) {
                    if (!res.error || !res.httpResponse || !res.httpResponse.headers) return;
                    if (res.error.name === 'TimeoutError') res.error.retryable = true;
                    console.log(
                        '[failed-request] request-id: %s | id-2: %s | %s s3://%s/%s | %s',
                        res.httpResponse.headers['x-amz-request-id'],
                        res.httpResponse.headers['x-amz-id-2'],
                        req, params.Bucket, params.Key,
                        res.error
                    );
                });
            });
        });

        q.awaitAll(callback);
    }
}

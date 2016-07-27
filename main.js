var TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
var VKAPI_ENDPOINT  = 'http://api.vk.com/method/';
var MYSQL_USERNAME  = process.env.MYSQL_USERNAME;
var MYSQL_PASSWORD  = process.env.MYSQL_PASSWORD;
var MYSQL_DATABASE  = 'subscriptions';
var PUBS_UPD_TIME   = 300000;   //msec
var PRESUB_TIME     = 60000000;  //msec
var WALL_REFRESH    = 30;

var TelegramBot   = require('node-telegram-bot-api');
var unirest       = require('unirest');
var request       = require('request-promise');
var parser        = require('minimist');
var mysql         = require('mysql');
var Promise       = require('bluebird');
var fs            = require('fs');

var pool          = mysql.createPool({
    connectionLimit : 100,
    host            : 'localhost',
    user            : MYSQL_USERNAME,
    password        : MYSQL_PASSWORD,
    database        : MYSQL_DATABASE
});
var bot           = new TelegramBot(TELEGRAM_TOKEN, {polling: true});

var helpText = 'This bot is about subscriptions to vk.com publics.' +
'\nYou can utilize it with the following commands:' +
'\n/help - view this message' +
'\n/sub publicname - subscribe to public' +
'\n/unsub publicname - unsubscribe from public' +
'\n/list - show current subscriptions';
var errorText = 'Whoops, something went horribly wrong!';

var writeFile = function(filename, contents) {
    return new Promise(function(resolve, reject) {
        fs.writeFile(filename, contents, 'binary', function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(filename);
            }
        });
    });
};

var unlink = function(filename) {
    return new Promise(function(resolve, reject) {
        fs.unlink(filename, function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(filename);
            }
        });
    });
};

var removeFilesOnRegex = function(dir, regex) {
    return new Promise(function(resolve, reject) {
        fs.readdir(dir, function(err, files) {
            if (err) {
                reject(err);
            } else {
                var promises = [];
                files.filter(function(file) {
                    return regex.test(file);
                }).forEach(function(file) {
                    promises.push(unlink(file));
                });
                Promise.all(promises).then(function() {
                    resolve();
                }).catch(function(err) {
                    reject(err);
                });
            }
        });
    });
};

var requestVKAPIMethod = function(method, params) {
    return new Promise(function(resolve, reject) {
        unirest.get(VKAPI_ENDPOINT + method).type('json')
                .query(params)
                .end(function(response) {
            if (response.error) {
                console.error(response.error);
                reject('Error while requesting ' + method +
                    ' with args ' + JSON.stringify(params));
            } else {
                resolve(response.body);
            }
        });
    });
};

var queryPool = function(pool, query) {
    return new Promise(function(resolve, reject) {
        pool.getConnection(function(err, connection) {
            if (err) {
                console.error(err);
                reject(err);
                return;
            }
            connection.query(query, function(err, rows) {
                if (err) {
                    console.error(err);
                    reject(err);
                    return;
                }
                connection.release();
                resolve(rows);
            });
        });
    });
};

// TODO: decide how to handle errors properly and refactor this three methods
// it looks awful
// check whether user is already subscribed
var processSubscription = function(chatId, publicName) {
    var timestamp = Math.floor((Date.now() - PRESUB_TIME) / 1000);
    return new Promise(function(resolve, reject) {
        if (!publicName) {
            reject('Give me something to subscribe to, dude');
            return;
        }
        requestVKAPIMethod('groups.getById', {'group_id' : publicName})
        .then(function(response) {
            console.log('Checking, whether public with name ' + publicName + ' exists');
            console.log('VK responsed with:');
            if (response.length > 200) {
                console.log('Too long to display');
            } else {
                console.log(response);
            }
            if (response.error) {
                reject("Can't find public with name like that");
                console.error(response.error);
            } else {
                queryPool(pool, 'INSERT IGNORE INTO sublist VALUES (' + mysql.escape(chatId) +
                ',' + mysql.escape(publicName) + ')').then(function() {
                    return checkPublic(publicName);
                }, reject).then(function(memes) {
                    console.log('Memes received');
                    console.log(memes);
                    sendMemes(chatId, timestamp, memes).then(function() {
                        resolve();
                    }).catch(reject);
                }, reject);
            }
        }, reject);
    });
};

var processUnsubscription = function(chatId, publicName) {
    return queryPool(pool, 'DELETE FROM sublist WHERE subscriber = ' + mysql.escape(chatId) +
        ' AND public = ' + mysql.escape(publicName));
};

var formSublist = function(chatId) {
    return queryPool(pool, 'SELECT public FROM sublist WHERE subscriber = ' + mysql.escape(chatId));
};

var refreshPublic = function(publicName) {
    var timestamp = Math.floor((Date.now() - PUBS_UPD_TIME) / 1000);
    return Promise.join(queryPool(pool, 'SELECT subscriber FROM sublist WHERE public = ' +
    mysql.escape(publicName)), checkPublic(publicName), function(subscribers, memes) {
        var promises = [];
        subscribers.forEach(function(element) {
            promises.push(sendMemes(element.subscriber, timestamp, memes));
        });
        return Promise.all(promises);
    });
};

var refreshFeed = function() {
    return queryPool(pool, 'SELECT DISTINCT public FROM sublist').then(function(rows) {
        console.log('Selected all publics now');
        var chain = Promise.resolve();
        rows.forEach(function(element) {
            chain = chain.then(function() {
                return refreshPublic(element.public);
            });
        });
        return chain;
    });
};

var sendMemes = function(chatId, timestamp, list) {
    console.log('Sending memes to ' + chatId);
    var chain = Promise.resolve();
    list.forEach(function(element) {
        if (parseInt(element.date) - parseInt(timestamp) <= 0) {
            return;
        }
        chain = chain.then(function() {
            console.log('Sending messages from ' + element.id);
            if (element.text) {
                return bot.sendMessage(chatId, element.text);
            } else {
                return Promise.resolve();
            }
        });
        if (!element.attachments) {
            return;
        }
        element.attachments.forEach(function(attachment) {
            if (attachment.type === 'photo') {
                var filename = chatId + '_' + attachment.photo.src_big.split('/').pop();
                chain = chain.then(function() {
                    return request(attachment.photo.src_big, {encoding: 'binary'});
                }).then(function(image) {
                    console.log('Saving photo ' + filename);
                    return writeFile(filename, image);
                }).then(function() {
                    console.log('Sending photos from ' + element.id);
                    return bot.sendPhoto(chatId, filename);
                }).then(function() {
                    console.log('Cleaning up');
                    return removeFilesOnRegex('.', /\.gif$|\.jpg$|\.jpeg$|\.png$/);
                });
            }
        });
    });
    return chain.then(function() {
        console.log('Everything was sent successfully');
    });
};

var checkPublic = function(publicName) {
    console.log("Now looking forward to see new posts from " + publicName);

    return requestVKAPIMethod('wall.get', {'domain': publicName, 'count': WALL_REFRESH})
    .then(function(rows) {
        return rows.response.slice(1);
    });
};

bot.on('text', function(msg) {
    console.log(msg.from.first_name + ' ' + msg.from.last_name + ' is on the line (' +
        msg.from.id + ', ' + msg.from.username + ').');
    args = msg.text.split(' ');
    parsed = parser(args);
    switch (parsed._[0]) {
        case '/sub':
            processSubscription(msg.chat.id, parsed._[1]).then(function(rows) {
                bot.sendMessage(msg.chat.id, 'Your are now subscribed to ' + parsed._[1]);
            }, function(err) {
                console.error(err);
                bot.sendMessage(msg.chat.id, errorText);
            });
            break;
        case '/unsub':
            processUnsubscription(msg.chat.id, parsed._[1]).then(function(rows) {
                bot.sendMessage(msg.chat.id,
                    'Successfully unsubscribed from ' + parsed._[1]);
            }, function(err) {
                console.error(err);
                bot.sendMessage(msg.chat.id, errorText);
            });
            break;
        case '/list':
            formSublist(msg.chat.id).then(function(list) {
                var response = 'Your current subscriptions are: \n';
                for (var i in list) {
                    response += list[i].public + '\n';
                }
                response += 'Anything else?';
                bot.sendMessage(msg.chat.id, response);
            }, function(err) {
                console.error(err);
                bot.sendMessage(msg.chat.id, error);
            });
            break;
        default:
            bot.sendMessage(msg.chat.id, helpText);
    }
    console.log('Received command with following args:');
    console.log(args);
    console.log('I parsed it like this');
    console.log(parsed);
});

refreshFeed();
setInterval(refreshFeed, PUBS_UPD_TIME);

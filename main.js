var TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
var VKAPI_ENDPOINT  = 'http://api.vk.com/method/wall.get';

var TelegramBot   = require('node-telegram-bot-api');
var unirest       = require('unirest');
var request       = require('request');
var parser        = require('minimist');
var bot           = new TelegramBot(TELEGRAM_TOKEN, {polling: true});

var helpText = 'Hi, I\'m HearthformerBot. I was made to give you all information about hearthstone cards.' +
'\nUse the following syntax to ask me something:' +
'\n/help - view this message' +
'\n/card <card name> [(-l | --locale) <locale name>] - get specified card in chosen locale (enUS is default)';
var errorText = 'Oops, something is wrong in your query!';

bot.on('text', function(msg) {
    console.log(msg.from.id);
    console.log(msg.from.first_name);
    console.log(msg.from.last_name);
    console.log(msg.from.username);
    args = msg.text.split(' ').slice(1);
    parsed = parser(args);
    unirest.get(VKAPI_ENDPOINT).type('json')
            .query({'domain': 'r_funny', 'count': 10})
            .end(function(response) {
                response = response.body;
                if (typeof response.error !== 'undefined') {
                    console.log(response.error);
                    return;
                }
                // console.log(response);
                response = response.response;
                for (var i = 1; i < response.length; ++i) {
                    element = response[i];
                    for (var j = 0; j < element.attachments.length; ++j) {
                        attachment = element.attachments[j];
                        if (attachment.type === 'photo') {
                            console.log(attachment.photo);
                            var image = request(attachment.photo.src_big);
                            bot.sendPhoto(msg.chat.id, image, {caption: element.text});
                        }
                    }
                }
            });
    console.log(args);
    console.log(parsed);
});

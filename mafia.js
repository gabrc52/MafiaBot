"use strict";

var config = require('./config.js');
var _ = require('lodash');
var store = require('node-persist');
var Discord = require('discord.js');

var roles = require('./roles');

var s = require('./pluralize.js');
var closestPlayer = require('./closestPlayer.js');

// init stuff
store.initSync();
var data = _.merge({
    syncMessages: [],

    channelsActivated: [],
    pmChannels: [],
    games: [],
}, store.getItem('data'));
store.setItemSync('data', data);
var mafiabot = new Discord.Client();

// synchronous messages
var syncMessage = (channelId, content) => {
    data.syncMessages.push({
        channelId: channelId,
        content: content,
    });
};
var syncReply = (message, content) => {
    syncMessage(message.channel.id, message.author + ', ' + content);
};
var readyToSendSyncMessage = true;
var timeLastSentSyncMessage = new Date();

// utilities
var getPlayerFromString = (str, channelId) => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel) {
        return closestPlayer(str, gameInChannel.players);
    }
    return null;
}
var adminCheck = message => {
    if (config.admins.indexOf(message.author.id) >= 0) {
        return true;
    }
    mafiabot.reply(message, `You must be an admin to perform command *${message.content}*!`);
    return false;
};
var activatedCheck = message => {
    return data.channelsActivated.indexOf(message.channel.id) >= 0;
}
var listUsers = listOfUserIds => {
    var output = '';
    for (var i = 0; i < listOfUserIds.length; i++) {
        output += `\n${i + 1}. <@${listOfUserIds[i]}>`;
    }
    return output;
}
var majorityOf = listOfPlayers => {
    return Math.ceil(_.filter(listOfPlayers, 'alive').length / 2 + 0.1);
}
var checkForLynch = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel) {
        var votesRequired = majorityOf(gameInChannel.players);
        var votesByTarget = _.groupBy(gameInChannel.votes, 'targetId');
        for (var targetId in votesByTarget) {
            if (votesByTarget[targetId].length >= votesRequired) {
                syncMessage(channelId, `**STOP! STOP! STOP! STOP! STOP! STOP! STOP! STOP!**`);
                syncMessage(channelId, `**STOP! STOP! STOP! STOP! STOP! STOP! STOP! STOP!**`);
                syncMessage(channelId, `**!! *NO TALKING AT NIGHT* !!**`);
                if (targetId == 'NO LYNCH') {
                    syncMessage(channelId, `No one was lynched.`);
                } else {
                    syncMessage(channelId, `<@${targetId}> was lynched.`);
                    _.find(gameInChannel.players, {id: targetId}).alive = false;
                }
                syncMessage(channelId, `**It is now night.**`);
                gameInChannel.day++;
                gameInChannel.votes.length = 0;
                printAlivePlayers(channelId);
                printDayState(channelId);
                break;
            }
        }
    }
}

// printing
var printCurrentPlayers = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel) {
        var output = `Currently ${s(gameInChannel.players.length, 'player')} in game hosted by <@${gameInChannel.hostId}>:${listUsers(_.map(gameInChannel.players, 'id'))}`;
        syncMessage(channelId, output);
        return true;
    }
    return false;
}
var printUnconfirmedPlayers = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel) {
        var unconfirmedPlayers = _.filter(gameInChannel.players, {confirmed: false});
        var output = unconfirmedPlayers.length 
            ? `${s(unconfirmedPlayers.length, 'player')} still must ##confirm for game hosted by <@${gameInChannel.hostId}>:${listUsers(_.map(unconfirmedPlayers, 'id'))}`
            : `All players confirmed for game hosted by <@${gameInChannel.hostId}>!`
            ;
        syncMessage(channelId, output);
        return true;
    }
    return false;
}
var printAlivePlayers = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel) {
        var output = `Currently ${s(_.filter(gameInChannel.players, 'alive').length, 'player')} alive in game hosted by <@${gameInChannel.hostId}>:${listUsers(_.map(_.filter(gameInChannel.players, 'alive'), 'id'))}`;
        syncMessage(channelId, output);
        return true;
    }
    return false;
}
var printDayState = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel && gameInChannel.day > 0) {
        syncMessage(channelId, 
`It is currently **${gameInChannel.state == STATE.DAY ? 'DAY' : 'NIGHT'} ${gameInChannel.day}** in game hosted by <@${gameInChannel.hostId}>!
**${_.filter(gameInChannel.players, 'alive').length} alive, ${majorityOf(gameInChannel.players)} to lynch!**
Use ##vote, ##NL, and ##unvote commands to vote.`
            );
        return true;
    }
    return false;
};
var printCurrentVotes = channelId => {
    var gameInChannel = _.find(data.games, {channelId: channelId});
    if (gameInChannel && gameInChannel.day > 0) {
        var votesByTarget = _.sortBy(_.toArray(_.groupBy(gameInChannel.votes, 'targetId'), function(group) { return -group.length; }));
        var voteOutput = '';
        for (var i = 0; i < votesByTarget.length; i++) {
            voteOutput += `\n(${votesByTarget[i].length}) <@${votesByTarget[i][0].targetId}>: ${_.map(_.sortBy(votesByTarget[i], function(vote) { return vote.time }), function(vote) { return '<@' + vote.playerId + '>'; }).join(', ')}`;
        }
        syncMessage(channelId,
`**${_.filter(gameInChannel.players, 'alive').length} alive, ${majorityOf(gameInChannel.players)} to lynch!**
Use ##vote, ##NL, and ##unvote commands to vote.${voteOutput}`
            );
        return true;
    }
    return false;
}

// states
var STATE = {
    INIT: 'Waiting for players',
    CONFIRMING: 'Waiting for confirmation from players',
    READY: 'Waiting for host to start game',
    DAY: 'Daytime, waiting for votes',
    NIGHT: 'Nighttime, waiting for actions',
};

// commands
var commandPrefix = '##';
var baseCommands = [
    {
        commands: ['commands', 'help', 'wut'],
        description: 'Show list of commands',
        adminOnly: false,
        activatedOnly: false,
        onMessage: message => {
            var output = `\nType one of the following commands to interact with MafiaBot:`;
            for (var i = 0; i < baseCommands.length; i++) {
                var comm = baseCommands[i];
                output += `\n**${commandPrefix}${comm.commands.join('/')}** - ${comm.description}${comm.adminOnly ? ' - *Admin Only*' : ''}${comm.activatedOnly ? ' - *Activated Channel Only*' : ''}`;
            }
            mafiabot.reply(message, output);
        },
    },
    {
        commands: ['admin', 'admins'],
        description: 'Show list of admins for MafiaBot',
        adminOnly: false,
        activatedOnly: false,
        onMessage: message => {
            mafiabot.sendMessage(message.channel, `Admins of MafiaBot:${listUsers(config.admins)}`);
        },
    },
    {
        commands: ['host', 'hosts'],
        description: 'Show host of current game in channel',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel) {
                mafiabot.sendMessage(message.channel, `Host of current game in channel:\n<@${gameInChannel.hostId}>`);
            } else {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);                
            }
        },
    },
    {
        commands: ['player', 'players'],
        description: 'Show current list of players of game in channel',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            if (!printCurrentPlayers(message.channel.id)) {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);         
            }
        },
    },
    {
        commands: ['activatemafia'],
        description: 'Activate MafiaBot on this channel',
        adminOnly: true,
        activatedOnly: false,
        onMessage: message => {
            if (data.channelsActivated.indexOf(message.channel.id) >= 0) {
                mafiabot.reply(message, `MafiaBot is already activated in *<#${message.channel.id}>*! Use *##deactivatemafia* to deactivate MafiaBot on this channel.`);
            } else {
                data.channelsActivated.push(message.channel.id);
                mafiabot.reply(message, `MafiaBot has been activated in *<#${message.channel.id}>*! Use *##creategame* to start playing some mafia!`);
            }
        },
    },
    {
        commands: ['deactivatemafia'],
        description: 'Deactivate MafiaBot on this channel',
        adminOnly: true,
        activatedOnly: false,
        onMessage: message => {
            if (data.channelsActivated.indexOf(message.channel.id) >= 0) {
                data.channelsActivated.splice(data.channelsActivated.indexOf(message.channel.id), 1);
                mafiabot.reply(message, `MafiaBot has been deactivated in *<#${message.channel.id}>*!`);
            } else {
                mafiabot.reply(message, `MafiaBot is not activate in *<#${message.channel.id}>*! Use *##activatemafia* to activate MafiaBot on this channel.`);
            }
        },
    },
    {
        commands: ['creategame'],
        description: 'Create a game in this channel and become the host',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel) {
                mafiabot.reply(message, `A game is already running in <#${message.channel.id}> hosted by <@${gameInChannel.hostId}>!`);
            } else {
                gameInChannel = {
                    channelId: message.channel.id,
                    hostId: message.author.id,
                    players: [],
                    votesToEndGame: [],
                    state: STATE.INIT,
                    day: 0,
                    night: false,
                    votes: [],
                };
                data.games.push(gameInChannel);
                mafiabot.sendMessage(message.channel, `Starting a game of mafia in <#${message.channel.id}> hosted by <@${gameInChannel.hostId}>!`);
            }
        },
    },
    {
        commands: ['endgame'],
        description: 'Current host, admin, or majority of players can end the game in this channel',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            var endGame = becauseOf => {
                _.remove(data.games, gameInChannel);
                mafiabot.sendMessage(message.channel, `${becauseOf} ended game of mafia in <#${message.channel.id}> hosted by <@${gameInChannel.hostId}>! 😥`);
            };
            if (gameInChannel) {
                if (gameInChannel.hostId == message.author.id) {
                    endGame(`Host <@${message.author.id}>`);
                } else if (config.admins.indexOf(message.author.id) >= 0) {
                    endGame(`Admin <@${message.author.id}>`);
                } else if (_.find(gameInChannel.players, {id: message.author.id})) {
                    if (gameInChannel.votesToEndGame.indexOf(message.author.id) >= 0) {
                        mafiabot.reply(message, `We already know you want to end the current game hosted by <@${gameInChannel.hostId}>!`);
                    } else {
                        gameInChannel.votesToEndGame.push(message.author.id);
                        mafiabot.reply(message, `You voted to end the current game hosted by <@${gameInChannel.hostId}>!`);
                        
                        var votesRemaining = majorityOf(gameInChannel.players) - gameInChannel.votesToEndGame.length;
                        if (votesRemaining <= 0) {
                            endGame('A majority vote of the players');
                        } else {
                            mafiabot.sendMessage(message.channel, `There are currently ${s(gameInChannel.votesToEndGame.length, 'vote')} to end the current game hosted by <@${gameInChannel.hostId}>. ${s(votesRemaining, 'vote')} remaining!`);
                        }
                    }
                } else {
                    mafiabot.reply(message, `Only admins, hosts, and joined players can end a game!`);
                }
            } else {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);
            }
        },
    },
    {
        commands: ['startgame'],
        description: 'Current host can start game with current list of players',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel) {
                if (gameInChannel.hostId == message.author.id) {
                    if (gameInChannel.state == STATE.INIT) {
                        gameInChannel.state = STATE.CONFIRMING;
                        syncMessage(message.channel.id, `Sending out roles for game of mafia hosted by <@${gameInChannel.hostId}>! Check your PMs for info and type **##confirm** in this channel to confirm your role.`);
                        printCurrentPlayers(message.channel.id);
                        for (var i = 0; i < gameInChannel.players.length; i++) {
                            mafiabot.sendMessage(_.find(mafiabot.users, {id: gameInChannel.players[i].id}), `Your role is ______. Type **##confirm** in <#${message.channel.id}> to confirm your participation in the game of mafia hosted by <@${gameInChannel.hostId}>.`);
                        }
                    } else if (gameInChannel.state == STATE.READY) {
                        gameInChannel.state = STATE.DAY;
                        gameInChannel.day = 1;
                        syncMessage(message.channel.id, `All players have confirmed and host <@${gameInChannel.hostId}> is now starting the game of mafia!`);
                        printCurrentPlayers(message.channel.id);
                        printDayState(message.channel.id);
                    }
                    } else {
                    mafiabot.reply(message, `Only hosts can start the game!`);
                }
            } else {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);
            }
        },
    },
    {
        commands: ['join', 'in'],
        description: 'Join the game in this channel as a player',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel) {
                if (gameInChannel.state == STATE.INIT) {
                    if (!_.find(data.pmChannels, {playerId: message.author.id})) {
                        mafiabot.reply(message, `You need to send me a private message to open up a direct channel of communication between us before you can join a game!`);                        
                    } else if (_.find(gameInChannel.players, {id: message.author.id})) {
                        mafiabot.reply(message, `You are already in the current game hosted by <@${gameInChannel.hostId}>!`);
                    } else {
                        var newPlayer = {
                            id: message.author.id,
                            name: message.author.name,
                            confirmed: false,
                            alive: true,
                        };
                        gameInChannel.players.push(newPlayer);
                        syncMessage(message.channel.id, `<@${message.author.id}> joined the current game hosted by <@${gameInChannel.hostId}>!`);
                        printCurrentPlayers(message.channel.id);
                    }
                } else {
                    mafiabot.reply(message, `The current game is already going, so the player list is locked!`);                    
                }
            } else {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);
            }
        },
    },
    {
        commands: ['unjoin', 'out', 'leave'],
        description: 'Leave the game in this channel, if you were joined',
        adminOnly: false,
        activatedOnly: true,
        onMessage: message => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel) {
                if (gameInChannel.state == STATE.INIT) {
                    if (_.find(gameInChannel.players, {id: message.author.id})) {
                        _.pullAllBy(gameInChannel.players, [{id: message.author.id}], 'id');
                        syncMessage(message.channel.id, `<@${message.author.id}> left the current game hosted by <@${gameInChannel.hostId}>!`);
                        printCurrentPlayers(message.channel.id);
                    } else {
                        mafiabot.reply(message, `You are not currently in the current game hosted by <@${gameInChannel.hostId}>!`);
                    }
                } else {
                    mafiabot.reply(message, `The current game is already starting, so the player list is locked!`);
                }
            } else {
                mafiabot.reply(message, `There's no game currently running in <#${message.channel.id}>!`);
            }
        },
    },
    {
        commands: ['confirm'],
        description: 'Confirm your role and your participation in the game',
        adminOnly: false,
        activatedOnly: true,
        onMessage: (message, args) => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel && gameInChannel.state == STATE.CONFIRMING) {
                var player = _.find(gameInChannel.players, {id: message.author.id});
                if (player) {
                    player.confirmed = true;
                    syncReply(message, `Thanks for confirming for the current game hosted by <@${gameInChannel.hostId}>!`);
                    printUnconfirmedPlayers(message.channel.id);

                    var unconfirmedPlayers = _.filter(gameInChannel.players, {confirmed: false});
                    if (!unconfirmedPlayers.length) {
                        gameInChannel.state = STATE.READY;
                    }
                }
            }
        },
    },
    {
        commands: ['vote', 'lynch'],
        description: 'Vote to lynch a player',
        default: true,
        adminOnly: false,
        activatedOnly: true,
        onMessage: (message, args) => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel && gameInChannel.state == STATE.DAY) {
                var player = _.find(gameInChannel.players, {id: message.author.id});
                if (player && player.alive) {
                    var target = getPlayerFromString(args[1], message.channel.id);
                    if (target) {
                        if (!target.alive) {
                            mafiabot.reply(message, `You can't vote for the dead player ${args[1]}'!`);
                        } else if (target.id == message.author.id) {
                            mafiabot.reply(message, `You can't vote for yourself!`);
                        } else {
                            _.pullAllBy(gameInChannel.votes, [{playerId: message.author.id}], 'playerId');
                            gameInChannel.votes.push({playerId: message.author.id, targetId: target.id, time: new Date()});
                            syncMessage(message.channel.id, `<@${message.author.id}> voted to lynch <@${target.id}>!`);

                            checkForLynch(message.channel.id);
                        }
                    } else {
                        mafiabot.reply(message, `'${args[1]}' is not a valid vote target!`);
                    }
                    printCurrentVotes(message.channel.id);
                }
            }
        },
    },
    {
        commands: ['nl', 'nolynch'],
        description: 'Vote for no lynch today',
        adminOnly: false,
        activatedOnly: true,
        onMessage: (message, args) => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel && gameInChannel.state == STATE.DAY) {
                var player = _.find(gameInChannel.players, {id: message.author.id});
                if (player && player.alive) {
                    _.pullAllBy(gameInChannel.votes, [{playerId: message.author.id}], 'playerId');
                    gameInChannel.votes.push({playerId: message.author.id, targetId: 'NO LYNCH', time: new Date()});
                    syncMessage(message.channel.id, `<@${message.author.id}> voted to No Lynch!`);

                    checkForLynch(message.channel.id);
                }
            }
        },
    },
    {
        commands: ['unvote', 'unlynch', 'un'],
        description: 'Remove your vote to lynch a player',
        adminOnly: false,
        activatedOnly: true,
        onMessage: (message, args) => {
            var gameInChannel = _.find(data.games, {channelId: message.channel.id});
            if (gameInChannel && gameInChannel.state == STATE.DAY) {
                var player = _.find(gameInChannel.players, {id: message.author.id});
                if (player && player.alive) {
                    var vote = _.find(gameInChannel.votes, {playerId: message.author.id});
                    _.pullAllBy(gameInChannel.votes, [{playerId: message.author.id}], 'playerId');
                    var targetString = vote ? ` <@${vote.targetId}>` : '... nothing';
                    syncMessage(message.channel.id, `<@${message.author.id}> unvoted${targetString}!`);
                    printCurrentVotes(message.channel.id);
                }
            }
        },
    },
];

// set up discord events
mafiabot.on("message", message => {
    var contentLower = message.content.toLowerCase();
    var args = message.content.split(/[ :]/);
    args[0] = args[0].substring(commandPrefix.length);
    // go through all the base commands and see if any of them have been called
    if (contentLower.indexOf(commandPrefix) == 0) {
        var anyCommandMatched = false;
        for (var i = 0; i < baseCommands.length; i++) {
            var comm = baseCommands[i];
            var commandMatched = false;
            for (var c = 0; c < comm.commands.length; c++) {
                commandMatched = 
                    args[0].toLowerCase().indexOf(comm.commands[c].toLowerCase()) == 0 && 
                    args[0].length == comm.commands[c].length;
                if (commandMatched) {
                    break;
                }
            }
            anyCommandMatched = anyCommandMatched || commandMatched;
            if (commandMatched) {
                if (!comm.adminOnly || adminCheck(message)) {
                    if (!comm.activatedOnly || activatedCheck(message)) {
                        comm.onMessage(message, args);
                    }
                }
                break;
            }
        }
        // call default command if no command was matched, but there was still a command prefix (like '##xxx')
        if (!anyCommandMatched) {
            var defaultComm = _.find(baseCommands, {default: true});
            if (defaultComm) {
                if (!defaultComm.adminOnly || adminCheck(message)) {
                    if (!defaultComm.activatedOnly || activatedCheck(message)) {
                        // args needs to be slightly modified for default commands (so '##xxx' has args ['', 'xxx'])
                        var args = [''].concat(message.content.split(/[ :]/));
                        args[1] = args[1].substring(commandPrefix.length);
                        defaultComm.onMessage(message, args);
                    }
                }
            }
        }
    }

    // receiving a PM
    if (message.channel.recipient) {
        if (!_.find(data.pmChannels, {playerId: message.channel.recipient.id})) {
            data.pmChannels.push({playerId: message.channel.recipient.id, channelId: message.channel.id});
            mafiabot.reply(message, 'Thanks for the one-time private message to open a direct channel of communication between us! You can join and play mafia games on this server.');
        }
    }

    // save data after every message
    store.setItemSync('data', data);
});

// main loop
var t = new Date();
var mainLoop = function() {
    // timing stuff
    var now = new Date();
    var dt = now - t;
    t = now;

    // handle sync message taking too long to call back
    if (now - timeLastSentSyncMessage >= config.syncMessageTimeout) {
        readyToSendSyncMessage = true;
    }

    // send next sync message if possible
    if (readyToSendSyncMessage && data.syncMessages.length) {
        var message = data.syncMessages.shift();
        mafiabot.sendMessage(message.channelId, message.content, {tts: false}, () => { readyToSendSyncMessage = true; });

        readyToSendSyncMessage = false;
        timeLastSentSyncMessage = new Date();
    }

    // save and wait for next loop
    store.setItemSync('data', data);
    setTimeout(mainLoop, Math.max(config.mainLoopInterval - (new Date() - now), 0));
};

// login and kick off main loop after everything is set up
mafiabot.login(config.email, config.password).then(() => { 
    // but wait for channels to be cached first or else there will be weird bugs
    var checkForChannelsThenKickoff = () => {
        if (mafiabot.channels.length) {
            mainLoop(0);
        } else {
            setTimeout(checkForChannelsThenKickoff, 100);
        }
    }
    checkForChannelsThenKickoff();
});
module.exports = mafiabot;
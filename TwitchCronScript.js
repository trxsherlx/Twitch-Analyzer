var DBManager = require("./DatabaseManager");
var request = require("request");
var async = require("async");
var tmi = require("tmi.js");
var config = require('./config');

var db;
var clipLogs = [];

var ircOptions = {
    options: {
        debug: false
    },
    connection: {
        reconnect: true
    },
    identity: {
        username: config.twitch.username,
        password: config.twitch.password
    },
    channels: []
};
var onlineStreamers = [];

var ircClient = new tmi.client(ircOptions);

TwitchCronScript();



function TwitchCronScript() {

    DBManager.connectToServer(config.dbUrl, function (err) {
        if (!err) {
            db = DBManager.getDb();

            // Connect the client to the server..
            ircClient.connect();

            // Run the viewer data collection ron
            viewerCron();

            // Run the clips data collection cron
            clipsDataCron();

            // Event Listener for IRC connection issues
            ircClient.on("error", function (message) {
                console.log("ERROR:=====>" + message);
            });

            // Event Listener to add messages to chat log db
            ircClient.on("chat", function (channel, userstate, message, self) {
                if (self) { // Don't listen to my own messages..
                    return;
                }
                // Do your stuff.
                var unixTimeSec = Math.floor(new Date() / 1000);
                var ircLog = {
                    unixTimeSec: unixTimeSec,
                    stream: channel.substring(1),
                    username: userstate["display-name"]
                };
                DBManager.insertData(ircLog, "chat_logs");
            });
        }
    });
}


function viewerCron() {
    config.streamerList.forEach(function (streamerName) {
        var apiUrl = "https://api.twitch.tv/kraken/streams?channel=" + streamerName + "&client_id=" + config.twitch.clientId;

        request({
            url: apiUrl,
            json: true
        }, function (error, response, body) {
            if (!error && response.statusCode === 200) {
                try {
                    if (body.streams.length > 0) {
                        var connectedToThese = ircClient.getChannels();
                        var temp = onlineStreamers.indexOf(streamerName);
                        if (temp == -1) {
                            onlineStreamers.push(streamerName);
                            checkIfStreamInLogs(streamerName, Math.floor((new Date(body.streams[0]['created_at']) / 1000)), "start");
                        }

                        var index = connectedToThese.indexOf("#" + streamerName);

                        if (index == -1) {
                            ircClient.join("#" + streamerName).then(function (data) {
                                console.log("Successful in joining the channel: #" + streamerName);
                                console.log("All the channels I'm connected to:" + connectedToThese);
                            }).catch(function (err) {
                                console.log("ERROR:: Problem while joining the channel: #" + streamerName);
                            });
                        }


                        var viewerCount = body.streams[0].viewers;
                        var unixTimeSec = Math.floor(new Date() / 1000);
                        var viewerCounts = {
                            unixTimeSec: unixTimeSec,
                            stream: streamerName,
                            viewerCount: viewerCount
                        };
                        DBManager.insertData(viewerCounts, "viewer_logs");

                    } else {

                        var index = onlineStreamers.indexOf(streamerName);
                        if (index > -1) {

                            ircClient.part("#" + onlineStreamers[index]).then(function (data) {
                                console.log("Parteded from #" + streamerName);
                            }).catch(function (err) {
                                console.log("ERROR:: Problem while parting from a channel: #" + streamerName);
                            });


                            checkIfStreamInLogs(streamerName, Math.floor(new Date() / 1000), "stop");

                            onlineStreamers.splice(index, 1);

                        }
                    }
                } catch (err) {

                }
            } else {
                console.log("Something went wrong while trying to get the viewer count for: " + streamerName);
            }
        });
    }, this);

    setTimeout(viewerCron, 5000);
}


// NOTICE: Multiple "stop" status from a same channel without a "start" between them means stream dropped
// keeping it this way so that we can choose to ignore the chat spam during that drop. Also twitch seems to
// have the entire stream in one single VOD even though there were drops.
function checkIfStreamInLogs(streamName, unixTimeSec, status) {
    streamName = streamName.toLowerCase();
    db.collection("stream_logs").find({
        'stream': streamName,
        'unixTimeSec': unixTimeSec,
        'status': status
    }).count(function (error, numOfDocs) {
        if (numOfDocs == 0) {
            console.log(streamName + "'s STREAM WAS CREATED ON:" + unixTimeSec);

            var streamLog = {
                unixTimeSec: unixTimeSec,
                stream: streamName,
                status: status
            };


            // NOTE: Make sure this part of code adds VOD id to stream_logs everytime. Even if the stream just started
            // IF IT DOESNT WORK: It might be becuase we made the api call to VODs list almost instantly after the streamer started streaming and so its not on the VOD list yet???
            if (status == "start") {
                var apiUrl = "https://api.twitch.tv/kraken/channels/" + streamName + "/videos?client_id=" + config.twitch.clientId + "&broadcasts=true";
                request({
                    url: apiUrl,
                    json: true
                }, function (error, response, body) {

                    body.videos.forEach(function (vod) {
                        if (vod.status == "recording") {
                            if (vod._id[0] == "v") {
                                streamLog.vod_id = vod._id.substring(1);
                            } else {
                                streamLog.vod_id = vod._id;
                            }
                            DBManager.insertData(streamLog, "stream_logs");
                        }
                    }, this);

                });
            } else {
                DBManager.insertData(streamLog, "stream_logs");
            }


        }
    });
}




// Clips data collection cron
function clipsDataCron() {
    var accumulatedClips = [];
    config.streamerList.forEach(function (streamerName) {
        getPopularClips(streamerName, "week", 100, null, function (data, done) {
            if (data.clips !== undefined) {
                Array.prototype.push.apply(accumulatedClips, data.clips);
                if (done !== undefined && done) {
                    addClipsToDB(accumulatedClips);
                }
            } else {
                console.log("ERROR: clips is undefined");
                console.log(data);
            }
        });
    });
}


function getPopularClips(streamName, timeFrame, limit, cursor, callback) {
    var uri = 'https://api.twitch.tv/kraken/clips/top?channel=' + streamName + '&period=' + timeFrame + '&limit=' + limit;
    if (cursor != null) {
        uri = 'https://api.twitch.tv/kraken/clips/top?channel=' + streamName + '&period=' + timeFrame + '&limit=' + limit + '&cursor=' + cursor;
    }
    request({
        headers: {
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Client-ID': config.twitch.clientId
        },
        uri: uri,
        method: 'GET'
    }, function (error, response, body) {
        //it works!
        if (!error && response.statusCode === 200) {
            var unparsedBody = body;
            body = JSON.parse(body);
            //console.log(unparsedBody);
            if ((body._cursor !== undefined || body._cursor != null) && body._cursor.length != 0) {
                //console.log("================================================= Another pass on clips API. Clip Cursor: " + body._cursor + ", Cursor length: " + body._cursor.length + " =========================")
                getPopularClips(streamName, timeFrame, limit, body._cursor, callback);
            } else {
                console.log("End of multi-page clips API call.");
                callback(body, true);
            }
        } else {
            console.log("ERROR: While getting Clips data for streamer: " + streamName + " and timeFrame:" + timeFrame);
            console.log("URL = " + uri);
        }
    });
}


function addClipsToDB(clips) {
    clipLogs = [];
    //clips.forEach(function (clip) {
    for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        var streamName = clip.broadcaster.name;
        var unixTimeSec = Math.floor((new Date(clip.created_at) / 1000));

        db.collection("clip_logs").find({
            'clip_slug': clip.slug
        }).count(function (error, numOfDocs) {
            if (numOfDocs == 0) { // Clips doesnt exist in DB so make a new entry/document for this clip
                if (clip.vod != null) {
                    var clipLog = {
                        unixTimeSec: unixTimeSec,
                        stream: streamName,
                        views: clip.views,
                        duration: clip.duration,
                        created_at: clip.created_at,
                        vod_url: clip.vod.url,
                        vod_id: clip.vod.id,
                        clip_slug: clip.slug
                    };

                    var timestampInSecs = clip.vod.url.substring(clip.vod.url.indexOf("?t=") + 3);
                    clipLog.timeDelaySecs = convertTimeStampToSeconds(timestampInSecs);

                    clipLogs.push(clipLog);

                } else {
                    console.log("Vod Deleted so not adding the clip to database");
                }
            } else { // Clip already exists in database just need to update data on it
                db.collection("clip_logs").updateOne({clip_slug: clip.slug}, {$set: {views: clip.views}});
            }
                console.log(i);

        }.bind({itr: i}));



    }
/*
    async.each(
        clips,
        function (clip, callback) {
            var streamName = clip.broadcaster.name;
            var unixTimeSec = Math.floor((new Date(clip.created_at) / 1000));

            db.collection("clip_logs").find({
                'clip_slug': clip.slug
            }).count(function (error, numOfDocs) {
                if (numOfDocs == 0) { // Clips doesnt exist in DB so make a new entry/document for this clip
                    if (clip.vod != null) {
                        var clipLog = {
                            unixTimeSec: unixTimeSec,
                            stream: streamName,
                            views: clip.views,
                            duration: clip.duration,
                            created_at: clip.created_at,
                            vod_url: clip.vod.url,
                            vod_id: clip.vod.id,
                            clip_slug: clip.slug
                        };

                        var timestampInSecs = clip.vod.url.substring(clip.vod.url.indexOf("?t=") + 3);
                        clipLog.timeDelaySecs = convertTimeStampToSeconds(timestampInSecs);

                        clipLogs.push(clipLog);

                    } else {
                        console.log("Vod Deleted so not adding the clip to database");
                    }
                } else { // Clip already exists in database just need to update data on it
                    db.collection("clip_logs").updateOne({
                        clip_slug: clip.slug
                    }, {
                        $set: {
                            views: clip.views
                        }
                    });
                }
            });
            callback();
        },
        function (err) {
            if (err) {
                console.log("Something went wrong while batching clips data." + err.message);
            } else {
                // Everything went well. Add all the clipLogs to DB
                console.log(clipLogs.length + " <= Size of clipsLog that is why not adding anything to DB")
                db.collection("clip_logs").insertMany(clipLogs);
            }
        }
    );
*/
}



function convertTimeStampToSeconds(timestamp) {
    var h = m = s = 0;
    var hp, mp, sp = -1;

    hp = timestamp.indexOf("h");
    if (hp != -1) {
        h = timestamp.substring(0, hp);
    }

    mp = timestamp.indexOf("m");
    if (mp != -1) {
        m = timestamp.substring(hp + 1, mp);
    }

    sp = timestamp.indexOf("s");
    if (sp != -1) {
        s = timestamp.substring(mp + 1, sp);
    }

    return ((parseInt(h) * 60 * 60) + (parseInt(m) * 60) + parseInt(s));
}
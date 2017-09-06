var secureServer = !!process.env.HTTPS;
var secureServerKey = process.env.HTTPS_KEY;
var secureServerCert = process.env.HTTPS_CRT;
var serverPort = +process.env.PORT || +process.argv[2] || (secureServer? 443: 80);
var bindAddress = process.env.BIND_ADDRESS || process.argv[3] || '::';
var infoSite = process.env.INFOSITE || "https://shields.io";
var githubApiUrl = process.env.GITHUB_URL || 'https://api.github.com';
var path = require('path');
var Camp = require('camp');
var camp = Camp.start({
  documentRoot: path.join(__dirname, 'public'),
  port: serverPort,
  hostname: bindAddress,
  secure: secureServer,
  cert: secureServerCert,
  key: secureServerKey
});
var tryUrl = require('url').format({
  protocol: secureServer ? 'https' : 'http',
  hostname: bindAddress,
  port: serverPort,
  pathname: 'try.html',
});
var domain = require('domain');
var request = require('request');
var log = require('./lib/log.js');
var LruCache = require('./lib/lru-cache.js');
var badge = require('./lib/badge.js');
var svg2img = require('./lib/svg-to-img.js');
var loadLogos = require('./lib/load-logos.js');
var githubAuth = require('./lib/github-auth.js');
var querystring = require('querystring');
var prettyBytes = require('pretty-bytes');
var xml2js = require('xml2js');
var serverSecrets = require('./lib/server-secrets');
if (serverSecrets && serverSecrets.gh_client_id) {
  githubAuth.setRoutes(camp);
}
log(tryUrl);

const {latest: latestVersion} = require('./lib/version.js');
const {
  compare: phpVersionCompare,
  latest: phpLatestVersion,
  isStable: phpStableVersion,
} = require('./lib/php-version.js');
const {
  currencyFromCode,
  metric,
  ordinalNumber,
  starRating,
} = require('./lib/text-formatters.js');
const {
  coveragePercentage: coveragePercentageColor,
  downloadCount: downloadCountColor,
  floorCount: floorCountColor,
  version: versionColor,
} = require('./lib/color-formatters.js');
const {
  analyticsAutoLoad,
  incrMonthlyAnalytics,
  getAnalytics
} = require('./lib/analytics');

var semver = require('semver');
var serverStartTime = new Date((new Date()).toGMTString());

var validTemplates = ['default', 'plastic', 'flat', 'flat-square', 'social'];
var darkBackgroundTemplates = ['default', 'flat', 'flat-square'];
var logos = loadLogos();

analyticsAutoLoad();
camp.ajax.on('analytics/v1', function(json, end) { end(getAnalytics()); });

var suggest = require('./lib/suggest.js');
camp.ajax.on('suggest/v1', suggest);

// Cache

// We avoid calling the vendor's server for computation of the information in a
// number of badges.
var minAccuracy = 0.75;

// The quotient of (vendor) data change frequency by badge request frequency
// must be lower than this to trigger sending the cached data *before*
// updating our data from the vendor's server.
// Indeed, the accuracy of our badges are:
// A(Δt) = 1 - min(# data change over Δt, # requests over Δt)
//             / (# requests over Δt)
//       = 1 - max(1, df) / rf
var freqRatioMax = 1 - minAccuracy;

// Request cache size of 5MB (~5000 bytes/image).
var requestCache = new LruCache(1000);

// Deep error handling for vendor hooks.
var vendorDomain = domain.create();
vendorDomain.on('error', function(err) {
  log.error('Vendor hook error:', err.stack);
});


function cache(f) {
  return function getRequest(data, match, end, ask) {
    if (data.maxAge !== undefined && /^[0-9]+$/.test(data.maxAge)) {
      ask.res.setHeader('Cache-Control', 'max-age=' + data.maxAge);
    } else {
      // Cache management - no cache, so it won't be cached by GitHub's CDN.
      ask.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    var reqTime = new Date();
    var date = (reqTime).toGMTString();
    ask.res.setHeader('Expires', date);  // Proxies, GitHub, see #221.
    ask.res.setHeader('Date', date);
    incrMonthlyAnalytics(getAnalytics().vendorMonthly);
    if (data.style === 'flat') {
      incrMonthlyAnalytics(getAnalytics().vendorFlatMonthly);
    } else if (data.style === 'flat-square') {
      incrMonthlyAnalytics(getAnalytics().vendorFlatSquareMonthly);
    }

    var cacheIndex = match[0] + '?label=' + data.label + '&style=' + data.style
      + '&logo=' + data.logo + '&logoWidth=' + data.logoWidth
      + '&link=' + JSON.stringify(data.link) + '&colorA=' + data.colorA
      + '&colorB=' + data.colorB;
    // Should we return the data right away?
    var cached = requestCache.get(cacheIndex);
    var cachedVersionSent = false;
    if (cached !== undefined) {
      // A request was made not long ago.
      var tooSoon = (+reqTime - cached.time) < cached.interval;
      if (tooSoon || (cached.dataChange / cached.reqs <= freqRatioMax)) {
        badge(cached.data.badgeData, makeSend(cached.data.format, ask.res, end));
        cachedVersionSent = true;
        // We do not wish to call the vendor servers.
        if (tooSoon) { return; }
      }
    }

    // In case our vendor servers are unresponsive.
    var serverUnresponsive = false;
    var serverResponsive = setTimeout(function() {
      serverUnresponsive = true;
      if (cachedVersionSent) { return; }
      if (requestCache.has(cacheIndex)) {
        var cached = requestCache.get(cacheIndex).data;
        badge(cached.badgeData, makeSend(cached.format, ask.res, end));
        return;
      }
      ask.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      var badgeData = getBadgeData('vendor', data);
      badgeData.text[1] = 'unresponsive';
      var extension;
      try {
        extension = match[0].split('.').pop();
      } catch(e) { extension = 'svg'; }
      badge(badgeData, makeSend(extension, ask.res, end));
    }, 25000);

    // Only call vendor servers when last request is older than…
    var cacheInterval = 5000;  // milliseconds
    var cachedRequest = function (uri, options, callback) {
      if ((typeof options === 'function') && !callback) { callback = options; }
      if (options && typeof options === 'object') {
        options.uri = uri;
      } else if (typeof uri === 'string') {
        options = {uri:uri};
      } else {
        options = uri;
      }
      options.headers = options.headers || {};
      options.headers['User-Agent'] = options.headers['User-Agent'] || 'Shields.io';
      return request(options, function(err, res, json) {
        if (res != null && res.headers != null) {
          var cacheControl = res.headers['cache-control'];
          if (cacheControl != null) {
            var age = cacheControl.match(/max-age=([0-9]+)/);
            if ((age != null) && (+age[1] === +age[1])) {
              cacheInterval = +age[1] * 1000;
            }
          }
        }
        callback(err, res, json);
      });
    };

    vendorDomain.run(function() {
      f(data, match, function sendBadge(format, badgeData) {
        if (serverUnresponsive) { return; }
        clearTimeout(serverResponsive);
        // Check for a change in the data.
        var dataHasChanged = false;
        if (cached !== undefined
          && cached.data.badgeData.text[1] !== badgeData.text[1]) {
          dataHasChanged = true;
        }
        // Add format to badge data.
        badgeData.format = format;
        // Update information in the cache.
        var updatedCache = {
          reqs: cached? (cached.reqs + 1): 1,
          dataChange: cached? (cached.dataChange + (dataHasChanged? 1: 0))
                            : 1,
          time: +reqTime,
          interval: cacheInterval,
          data: { format: format, badgeData: badgeData }
        };
        requestCache.set(cacheIndex, updatedCache);
        if (!cachedVersionSent) {
          badge(badgeData, makeSend(format, ask.res, end));
        }
      }, cachedRequest);
    });
  };
}

module.exports = {
  camp,
  requestCache
};

camp.notfound(/\.(svg|png|gif|jpg|json)/, function(query, match, end, request) {
    var format = match[1];
    var badgeData = getBadgeData("404", query);
    badgeData.text[1] = 'badge not found';
    badgeData.colorscheme = 'red';
    // Add format to badge data.
    badgeData.format = format;
    badge(badgeData, makeSend(format, request.res, end));
});

camp.notfound(/.*/, function(query, match, end, request) {
  end(null, {template: '404.html'});
});



// Vendors.

/******************************
CHEERS, BILIBILI.

APIs currently support the following badges

- video availability -
- danmaku count of video -
- share count of video - 
- coin count of video -
- fav count of video -

Note: please do always include the availability badge before any other badge as the other badges don't provide "Bilibili" or AV number.
******************************/

// Bilibili Video Availabiility integration.
camp.route(/^\/bilibili\/video\/av\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var avid = match[1];  // eg, 7248433
  var format = match[2];
  var url = 'https://api.bilibili.com/archive_stat/stat?aid=' + avid +'&type=jsonp&_=1482889080665';
  var badgeData = getBadgeData('Bilibili', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
	  badgeData.colorscheme = 'lightgrey';
      badgeData.text[1] = 'Unavailable';
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var avstate = data.code;
      badgeData.text[1] = "av" + avid;
      if (avstate != 0) {
        badgeData.colorscheme = 'lightgrey';
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#DE6A8B';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Bilibili video danmaku count integration.
camp.route(/^\/bilibili\/danmaku\/av\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var avid = match[1];  // eg, 7248433
  var format = match[2];
  var url = 'https://api.bilibili.com/archive_stat/stat?aid=' + avid +'&type=jsonp&_=1482889080665';
  var badgeData = getBadgeData('Danmakus', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable';
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var avstate = data.code;
      var danmakucount = data.data.danmaku;
      if (avstate != 0) {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#9FC1E0';
	badgeData.text[1] = danmakucount;
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Bilibili share count integration.
camp.route(/^\/bilibili\/share\/av\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var avid = match[1];  // eg, 7248433
  var format = match[2];
  var url = 'https://api.bilibili.com/archive_stat/stat?aid=' + avid +'&type=jsonp&_=1482889080665';
  var badgeData = getBadgeData('Shares', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
	  badgeData.colorscheme = 'lightgrey';
      badgeData.text[1] = 'Unavailable';
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var sharecount = data.data.share;
      var avstate = data.code;
      if (avstate != 0) {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = "#31C57B";
	badgeData.text[1] = sharecount;
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Bilibili coins count integration.
camp.route(/^\/bilibili\/coin\/av\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var avid = match[1];  // eg, 7248433
  var format = match[2];
  var url = 'https://api.bilibili.com/archive_stat/stat?aid=' + avid +'&type=jsonp&_=1482889080665';
  var badgeData = getBadgeData('Coins', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
	  badgeData.colorscheme = 'lightgrey';
      badgeData.text[1] = 'Unavailable';
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var coinscount = data.data.coin;
      var avstate = data.code;
      if (avstate != 0) {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = "#FFC529";
	badgeData.text[1] = coinscount;
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Bilibili video favourites count integration.
camp.route(/^\/bilibili\/fav\/av\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var avid = match[1];  // eg, 7248433
  var format = match[2];
  var url = 'https://api.bilibili.com/archive_stat/stat?aid=' + avid +'&type=jsonp&_=1482889080665';
  var badgeData = getBadgeData('Favourites', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable';
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var avstate = data.code;
      var favcount = data.data.favorite;
      if (avstate != 0) {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#F69CB4';
	badgeData.text[1] = favcount;
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

/*******************************
NETEASE, THE POWER OF MUSIC.

- Name of single song (DEPRECATED) -
- Name of specific album (UNDER ASSESSMENT)
- Name of specific playlist (UNDER ASSESSMENT)
- Comment count of single song -
- Comment count of specific album -
- Comment count of specific playlist -
- Play count of specific playlist -
- Share count of specific playlist -
- Subscribed count of specific playlist -
*******************************/

// Name of single song integration

camp.route(/^\/netease\/song\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var songid = match[1];  // eg, 454905890
  var format = match[2];
  var url = 'http://localhost:2234/song/detail?ids=' + songid;
  var badgeData = getBadgeData('Netease Music', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var songname = data.songs[0].name;
      var songalbum = data.songs[0].al.name;
      var songstate = data.code;
      if (songstate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable" + songstate;
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = songname + " - " + songalbum;
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable' + " " + e;
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Comment count of song integration

camp.route(/^\/netease\/comments\/song\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var songid = match[1];  // eg, 454905890
  var format = match[2];
  var url = 'http://localhost:2234/comment/music/?id=' + songid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var songcommentcount = data.total;
      var songstate = data.code;
      if (songstate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = songcommentcount + ' comments';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Comment count of album integration

camp.route(/^\/netease\/comments\/album\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var albumid = match[1];  // eg, 35024849
  var format = match[2];
  var url = 'http://localhost:2234/comment/album/?id=' + albumid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var albumcommentcount = data.total;
      var albumstate = data.code;
      if (albumstate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = albumcommentcount + ' comments';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Comment count of playlist integration

camp.route(/^\/netease\/comments\/playlist\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var playlistid = match[1];  // eg, 50498726
  var format = match[2];
  var url = 'http://localhost:2234/comment/playlist/?id=' + playlistid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var playlistcommentcount = data.total;
      var playliststate = data.code;
      if (playliststate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = playlistcommentcount + ' comments';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Playtimes count of playlist integration

camp.route(/^\/netease\/playtimes\/playlist\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var playlistid = match[1];  // eg, 50498726
  var format = match[2];
  var url = 'http://localhost:2234/playlist/detail/?id=' + playlistid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var playcount = data.playlist.playCount;
      var playliststate = data.code;
      if (playliststate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = playcount + ' times played';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Share count of playlist integration

camp.route(/^\/netease\/shares\/playlist\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var playlistid = match[1];  // eg, 50498726
  var format = match[2];
  var url = 'http://localhost:2234/playlist/detail/?id=' + playlistid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var sharecount = data.playlist.shareCount;
      var playliststate = data.code;
      if (playliststate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = sharecount + ' times shared';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));

// Subscription count of playlist integration

camp.route(/^\/netease\/subscribes\/playlist\/([^\/]+)\.(svg|png|gif|jpg|json)$/,
cache(function(data, match, sendBadge, request) {
  var playlistid = match[1];  // eg, 50498726
  var format = match[2];
  var url = 'http://localhost:2234/playlist/detail/?id=' + playlistid;
  var badgeData = getBadgeData('Netease', data);
  request(url, function(err, res, buffer) {
    if (err != null) {
      badgeData.colorscheme = "lightgrey";
      badgeData.text[1] = 'Unavailable' + err;
      sendBadge(format, badgeData);
      return;
    }
        try {
      var data = JSON.parse(buffer);
      var subscribedcount = data.playlist.subscribedCount;
      var playliststate = data.code;
      if (playliststate != "200") {
        badgeData.colorscheme = 'lightgrey';
        badgeData.text[1] = "Unavailable";
      } else {
        badgeData.colorscheme = null;
	badgeData.colorB = '#D53931';
	badgeData.text[1] = subscribedcount + ' people subscribed';
		}
	sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'Unavailable';
      badgeData.colorscheme = 'lightgrey';
      sendBadge(format, badgeData);
    }
  });
}));


// Any badge.
camp.route(/^\/(:|badge\/)(([^-]|--)*?)-(([^-]|--)*)-(([^-]|--)+)\.(svg|png|gif|jpg)$/,
function(data, match, end, ask) {
  var subject = escapeFormat(match[2]);
  var status = escapeFormat(match[4]);
  var color = escapeFormat(match[6]);
  var format = match[8];

  incrMonthlyAnalytics(getAnalytics().rawMonthly);
  if (data.style === 'flat') {
    incrMonthlyAnalytics(getAnalytics().rawFlatMonthly);
  } else if (data.style === 'flat-square') {
    incrMonthlyAnalytics(getAnalytics().rawFlatSquareMonthly);
  }

  // Cache management - the badge is constant.
  var cacheDuration = (3600*24*1)|0;    // 1 day.
  ask.res.setHeader('Cache-Control', 'max-age=' + cacheDuration);
  if (+(new Date(ask.req.headers['if-modified-since'])) >= +serverStartTime) {
    ask.res.statusCode = 304;
    ask.res.end();  // not modified.
    return;
  }
  ask.res.setHeader('Last-Modified', serverStartTime.toGMTString());

  // Badge creation.
  try {
    var badgeData = getBadgeData(subject, data);
    badgeData.colorscheme = undefined;
    if (data.label !== undefined) { badgeData.text[0] = '' + data.label; }
    badgeData.text[1] = status;
    if (badgeData.colorB === undefined) {
      if (sixHex(color)) {
        badgeData.colorB = '#' + color;
      } else if (badgeData.colorA === undefined) {
        badgeData.colorscheme = color;
      }
    }
    if (data.style && validTemplates.indexOf(data.style) > -1) {
      badgeData.template = data.style;
    }
    badge(badgeData, makeSend(format, ask.res, end));
  } catch(e) {
    log.error(e.stack);
    badge({text: ['error', 'bad badge'], colorscheme: 'red'},
      makeSend(format, ask.res, end));
  }
});

// Production cache debugging.
var bitFlip = false;
camp.route(/^\/flip\.svg$/, function(data, match, end, ask) {
  var cacheSecs = 60;
  ask.res.setHeader('Cache-Control', 'max-age=' + cacheSecs);
  var reqTime = new Date();
  var date = (new Date(+reqTime + cacheSecs * 1000)).toGMTString();
  ask.res.setHeader('Expires', date);
  var badgeData = getBadgeData('flip', data);
  bitFlip = !bitFlip;
  badgeData.text[1] = bitFlip? 'on': 'off';
  badgeData.colorscheme = bitFlip? 'brightgreen': 'red';
  badge(badgeData, makeSend('svg', ask.res, end));
});

// Any badge, old version.
camp.route(/^\/([^\/]+)\/(.+).png$/,
function(data, match, end, ask) {
  var subject = match[1];
  var status = match[2];
  var color = data.color;

  // Cache management - the badge is constant.
  var cacheDuration = (3600*24*1)|0;    // 1 day.
  ask.res.setHeader('Cache-Control', 'max-age=' + cacheDuration);
  if (+(new Date(ask.req.headers['if-modified-since'])) >= +serverStartTime) {
    ask.res.statusCode = 304;
    ask.res.end();  // not modified.
    return;
  }
  ask.res.setHeader('Last-Modified', serverStartTime.toGMTString());

  // Badge creation.
  try {
    var badgeData = {text: [subject, status]};
    badgeData.colorscheme = color;
    badge(badgeData, makeSend('png', ask.res, end));
  } catch(e) {
    badge({text: ['error', 'bad badge'], colorscheme: 'red'},
      makeSend('png', ask.res, end));
  }
});

// Redirect the root to the website.
camp.route(/^\/$/, function(data, match, end, ask) {
  ask.res.statusCode = 302;
  ask.res.setHeader('Location', infoSite);
  ask.res.end();
});

// Escapes `t` using the format specified in
// <https://github.com/espadrine/gh-badges/issues/12#issuecomment-31518129>
function escapeFormat(t) {
  return t
    // Inline single underscore.
    .replace(/([^_])_([^_])/g, '$1 $2')
    // Leading or trailing underscore.
    .replace(/([^_])_$/, '$1 ').replace(/^_([^_])/, ' $1')
    // Double underscore and double dash.
    .replace(/__/g, '_').replace(/--/g, '-');
}

function escapeFormatSlashes(t) {
  return escapeFormat(t)
    // Double slash
    .replace(/\/\//g, '/');
}


function sixHex(s) { return /^[0-9a-fA-F]{6}$/.test(s); }

function getLabel(label, data) {
  return data.label || label;
}

function colorParam(color) { return (sixHex(color) ? '#' : '') + color; }

// data (URL query) can include `label`, `style`, `logo`, `logoWidth`, `link`,
// `colorA`, `colorB`.
// It can also include `maxAge`.
function getBadgeData(defaultLabel, data) {
  var label = getLabel(defaultLabel, data);
  var template = data.style || 'default';
  if (data.style && validTemplates.indexOf(data.style) > -1) {
    template = data.style;
  }
  if (!(Object(data.link) instanceof Array)) {
    if (data.link === undefined) {
      data.link = [];
    } else {
      data.link = [data.link];
    }
  }

  if (data.logo !== undefined && !/^data:/.test(data.logo)) {
    data.logo = 'data:' + data.logo;
  }

  if (data.colorA !== undefined) {
    data.colorA = colorParam(data.colorA);
  }
  if (data.colorB !== undefined) {
    data.colorB = colorParam(data.colorB);
  }

  return {
    text: [label, 'n/a'],
    colorscheme: 'lightgrey',
    template: template,
    logo: data.logo,
    logoWidth: +data.logoWidth,
    links: data.link,
    colorA: data.colorA,
    colorB: data.colorB
  };
}

function makeSend(format, askres, end) {
  if (format === 'svg') {
    return function(res) { sendSVG(res, askres, end); };
  } else if (format === 'json') {
    return function(res) { sendJSON(res, askres, end); };
  } else {
    return function(res) { sendOther(format, res, askres, end); };
  }
}

function sendSVG(res, askres, end) {
  askres.setHeader('Content-Type', 'image/svg+xml;charset=utf-8');
  end(null, {template: streamFromString(res)});
}

function sendOther(format, res, askres, end) {
  askres.setHeader('Content-Type', 'image/' + format);
  svg2img(res, format, function (err, data) {
    if (err) {
      // This emits status code 200, though 500 would be preferable.
      log.error('svg2img error', err);
      end(null, {template: '500.html'});
    } else {
      end(null, {template: streamFromString(data)});
    }
  });
}

function sendJSON(res, askres, end) {
  askres.setHeader('Content-Type', 'application/json');
  askres.setHeader('Access-Control-Allow-Origin', '*');
  end(null, {template: streamFromString(res)});
}

var stream = require('stream');
function streamFromString(str) {
  var newStream = new stream.Readable();
  newStream._read = function() { newStream.push(str); newStream.push(null); };
  return newStream;
}

// Map from URL to { timestamp: last fetch time, interval: in milliseconds,
// data: data }.
var regularUpdateCache = Object.create(null);
// url: a string, scraper: a function that takes string data at that URL.
// interval: number in milliseconds.
// cb: a callback function that takes an error and data returned by the scraper.
function regularUpdate(url, interval, scraper, cb) {
  var timestamp = Date.now();
  var cache = regularUpdateCache[url];
  if (cache != null &&
      (timestamp - cache.timestamp) < interval) {
    cb(null, regularUpdateCache[url].data);
    return;
  }
  request(url, function(err, res, buffer) {
    if (err != null) { cb(err); return; }
    if (regularUpdateCache[url] == null) {
      regularUpdateCache[url] = { timestamp: 0, data: 0 };
    }
    try {
      var data = scraper(buffer);
    } catch(e) { cb(e); return; }
    regularUpdateCache[url].timestamp = timestamp;
    regularUpdateCache[url].data = data;
    cb(null, data);
  });
}

// Get data from a svg-style badge.
// cb: function(err, string)
function fetchFromSvg(request, url, cb) {
  request(url, function(err, res, buffer) {
    if (err != null) { return cb(err); }
    try {
      var badge = buffer.replace(/(?:\r\n\s*|\r\s*|\n\s*)/g, '');
      var match = />([^<>]+)<\/text><\/g>/.exec(badge);
      if (!match) { return cb(Error('Cannot fetch from SVG:\n' + buffer)); }
      cb(null, match[1]);
    } catch(e) {
      cb(e);
    }
  });
}

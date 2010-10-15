/*
Please do not edit this file directly (unless you intend to fork).
  It's been open-sourced here:
    http://github.com/dgouldin/django-hashsignal

Requires
  * jQuery hashchange event - v1.2 - 2/11/2010
  * http://benalman.com/projects/jquery-hashchange-plugin/
*/

(function(window, $, undefined){
    var activeOpts, defaultOpts, insertId = 0;

    function log() {
        if (!(activeOpts && activeOpts.debug)) {
            return;
        }
        var args = [new Date(), "hashsignal"].concat(Array.prototype.slice.apply(arguments));
        if (window.console) {
            window.console.log(args);
        } else {
         return; // TODO: replacement for console.log
        }
    }
    
    defaultOpts = {
        excludeSelector: '.no-ajax',
        beforeUpdate: function() { log('beforeUpdate'); },
        afterUpdate: function() { log('afterUpdate'); },
        errorUpdate: function() { log('errorUpdate'); },
        onDocumentWrite: function(msg) {
          if (window.console) {
            window.console.error("jQuery.hashsignal received document.write: " + msg);
          }
        },
        debug: false,
        disabled: false
    };

    var methods, ALWAYS_RELOAD = '__all__', HASH_REPLACEMENT = ':',
        previousLocation = null, upcomingLocation = null,
        previousSubhash = null,
        transitions = {}, liveFormsSel, document = window.document,
        location = window.location, history = window.history;

    function blockAction(actionName, blockName) { 
        /* DRYs up _unloadBlock and _loadBlock below */
        var transition = transitions[blockName];
        if (!transition) {
            return;
        }
        for (var name in transition) {
            if (transition.hasOwnProperty(name)) {
                transition[name][actionName]();
                /* Clean up old transitions which are no longer needed. */
                if( actionName === 'unload' && !transition[name].o.runOnce && blockName != ALWAYS_RELOAD) {
                    delete transition[name];
                }
            }
        }
    }

    function getOldBlocks(doc) {
        function walker(root, handle) {
          handle(root);
          for (var i=0, c=root.childNodes.length; i < c; i++) {
            walker(root.childNodes[i], handle);
          }
        }
        var blockRe = /^ (end)?block ([^ ]*) ([0-9a-f]{32} )?$/;
        function blockWalker(root, handle) { //handle(name, isStart, node)
          walker(root, function(node) {
            if (node.nodeType === 8) { // comment node
              var match = blockRe.exec(node.nodeValue);
              if (match) {
                handle(match[2], match[3], !match[1], node);
              }
            }
          });
        }

        var blocks = {};
        doc = doc || document;
        blockWalker(doc, function(name, signature, isStart, node) {
            if (blocks[name] === undefined) {
                blocks[name] = {
                    nodes: [null, null],
                    signature: signature
                };
            }
            blocks[name].nodes[isStart ? 0 : 1] = node;
        });
        return blocks;
    }
    
    function getNewBlocks(html) {
        var blocker = /<!-- (end)?block ([^ ]*) ([0123456789abcdef]{32} )?-->/gi;
        var starts = []; //stack of {name:a, signature:x, start:y};
        var closing;
        var blocks = {}; //name: {signature:x, html:z}

        function last() {
          return starts[starts.length-1];
        }

        html.replace(blocker, function(matched, ending, blockName, signatureMaybe, offset, fullString) {
          if (ending && starts.length === 0) {
            throw "Unexpected block nesting on match: " + matched;
          }
          if (!ending && !signatureMaybe) {
            throw "Expected signature on start of block";
          }

          if (ending) {
            closing = last();
            starts.length = starts.length-1;
            blocks[closing.name] = {
              html: fullString.slice(closing.start, offset),
              signature: closing.signature
            };
          } else {
            starts.push({
              name: blockName,
              start: offset + matched.length,
              signature: signatureMaybe
            });
          }
        });
        if (0 !== starts.length) {
          throw "Unclosed block: " + last().name;
        }
        return blocks;
    }
    
    function replaceBlocks(html, forceReload) {
        log('replaceBlocks');

        function siblingsBetween(start, end) {
            var siblings = [];
            var current = start;
            while (current !== end) {
                if (current !== start) {
                    siblings.push(current);
                }
                current = current.nextSibling;
            }
            return siblings;
        }

        var oldBlocks = getOldBlocks();
        var newBlocks = getNewBlocks(html);

        methods._unloadBlock(ALWAYS_RELOAD);

        for (var blockName in newBlocks) {
            if (blockName in oldBlocks) {
                var oldBlock = oldBlocks[blockName];
                var newBlock = newBlocks[blockName];
                if (oldBlock.signature === newBlock.signature && !forceReload) {
                    log('Not replacing block, signatures match.', blockName, oldBlock.signature);
                    continue; // The block is the same, no need to swap out the content.
                }

                methods._unloadBlock(blockName);
                $(siblingsBetween(oldBlock.nodes[0], oldBlock.nodes[1])).remove();

                log('Replacing block', blockName, newBlock.html);
                // methods._loadBlock must be called from inside newBlock.html so that mutations block as 
                //   would normally happen with inline scripts.
                $(oldBlock.nodes[0]).after(newBlock.html +
                '<script type="text/javascript">' +
                '  jQuery.hashsignal._loadBlock("' + blockName.replace('"', '\\"') + '");' +
                '</scr' + 'ipt><div id="hashsignal-' + insertId + '">&nbsp;</div>');
                if (0 == $("#hashsignal-" + insertId).length) {
                  if (window.console && window.console.error) {
                    window.console.error("Unable to insert into " + blockName + " - is your HTML valid?");
                  }
                }
                insertId += 1;

                // update block signature
                $(oldBlock.nodes[0]).replaceWith("<!-- block " + blockName + " " + newBlock.signature + "-->");
            } else {
                log('WARNING: unmatched block', blockName);
            }
        }
        methods._loadBlock(ALWAYS_RELOAD);

        // update title
        var titleRe = /<title>(.*)<\/title>/;
        var titleMatch = titleRe.exec(html);
        if (titleMatch) {
            document.title = titleMatch[1];
        }
    }

    function updatePage(opts) {
        var o = $.extend({
            url: (previousLocation || '') + '#' + (previousSubhash || ''),
            type: 'GET',
            data: '',
            forceReload: false
        }, opts);
        var callbacks = $.extend({
            beforeUpdate: function() { return; },
            afterUpdate: function() { return; },
            errorUpdate: function() { return; }
        }, activeOpts);

        var urlParts = o.url.split("#"), expectedLocation, subhash;

        expectedLocation = urlParts[0] || previousLocation;
        subhash = urlParts[1] || '';

        if (expectedLocation == previousLocation &&
            subhash != previousSubhash) {
            $(window).trigger('hashsignal.hashchange', [subhash]);
            previousSubhash = subhash;
            return;
        }

        if (!o.forceReload && expectedLocation == previousLocation &&
            o.type.toLowerCase() === 'get' && !o.data) {
            return;
        }

        //deal with multiple pending requests by always having the 
        // last-requested win, rather than last-responded.
        upcomingLocation = expectedLocation;
        function makeSuccessor(expectedLocation) {
          return function(data, status, xhr) {
              if (expectedLocation != upcomingLocation) {
                  log("Success for ", expectedLocation, " fired but last-requested was ", upcomingLocation, " - aborting");
                  return;
              }

              log('updatePage onSuccess');

              // If response body contains a redirect location, perform the redirect.
              // This is an xhr-compatible proxy for 301/302 responses.
              if (typeof data === 'object' && data.redirectLocation) {
                  log('redirecting page', data.redirectLocation);
                  previousLocation = expectedLocation;
                  previousSubhash = subhash;
                  location.replace('#' + hrefToHash(data.redirectLocation));
                  return;
              }

              replaceBlocks(data, o.forceReload);

              if (subhash) {
                  $(window).trigger('hashsignal.hashchange', [subhash]);
              }
              previousLocation = expectedLocation;
              previousSubhash = subhash;

              callbacks.afterUpdate();
          };
        }

        callbacks.beforeUpdate();
        $.ajax({
            data: o.data,
            error: function(xhr, status, error) {
                log('updatePage error');
                callbacks.errorUpdate(xhr, status, error);
                history.back();
            },
            success: makeSuccessor(expectedLocation),
            beforeSend: function(xhr) {
              xhr.setRequestHeader('X-Hashsignal', 'Hashsignal');
            },
            type: o.type,
            url: expectedLocation
        });
    }

    function Transition(opts) {
        this.hasRun = false;
        this.o = $.extend({
            load: function(){ return; },
            unload: function() { return; },
            runOnce: false
        }, opts);

        this.events = [];
        this.timeouts = [];
        this.intervals = [];
        this.scripts = {};

        // shims
        this.bind = function(obj, eventType, eventData, handler) {
            this.events.push([obj, eventType, handler]);
            return $(obj).bind(eventType, eventData, handler);
        };
        this.setTimeout = function(callback, timeout) {
            this.timeouts.push(window.setTimeout(callback, timeout));
        };
        this.setInterval = function(callback, timeout) {
            this.intervals.push(window.setInterval(callback, timeout));
        };
        this.clearTimeout = window.clearTimeout;
        this.clearInterval = window.clearInterval;
        
        this.addScript = function(src, loadOnce) {
            loadOnce = loadOnce === undefined ? true : loadOnce;
            if (!(loadOnce && this.scripts[src])) {
                var script = document.createElement('script');
                script.type = 'text/javascript';
                script.src = src;
                script = $(script);

                var that = this;
                script.load(function(){
                    that.scripts[src] = true;
                    $(this).unbind('load');
                });

                $('body').append(script);
            }
        };

        this.load = function() {
            if (!(this.hasRun && this.runOnce)) {
                this.o.load(this);
            }
            this.hasRun = true;
        };
        this.unload = function() {
            if (!this.runOnce) {
                var i;
                for (i = 0; i < this.events.length; i++) {
                    var e = this.events[i];
                    $(e[0]).unbind(e[1], e[2]);
                }
                for (i = 0; i < this.timeouts.length; i++) {
                    window.clearTimeout(this.timeouts[i]);
                }
                for (i = 0; i < this.intervals.length; i++) {
                    window.clearInterval(this.intervals[i]);
                }
                this.o.unload(this);
            }
        };
    }

    /*
    http://tools.ietf.org/html/rfc3986#section-5.4
        based on http://a/b/c/d;p?q
        
        "g:h"           =  "g:h"
        "g"             =  "http://a/b/c/g"
        "./g"           =  "http://a/b/c/g"
        "g/"            =  "http://a/b/c/g/"
        "/g"            =  "http://a/g"
        "//g"           =  "http://g"
        "?y"            =  "http://a/b/c/d;p?y"
        "g?y"           =  "http://a/b/c/g?y"
        "#s"            =  "http://a/b/c/d;p?q#s"
        "g#s"           =  "http://a/b/c/g#s"
        "g?y#s"         =  "http://a/b/c/g?y#s"
        ";x"            =  "http://a/b/c/;x"
        "g;x"           =  "http://a/b/c/g;x"
        "g;x?y#s"       =  "http://a/b/c/g;x?y#s"
        ""              =  "http://a/b/c/d;p?q"
        "."             =  "http://a/b/c/"
        "./"            =  "http://a/b/c/"
        ".."            =  "http://a/b/"
        "../"           =  "http://a/b/"
        "../g"          =  "http://a/b/g"
        "../.."         =  "http://a/"
        "../../"        =  "http://a/"
        "../../g"       =  "http://a/g"
    abnormal
        traverse past 
         "../../../g"    =  "http://a/g"
         "../../../../g" =  "http://a/g"
        nonsense traversal
         "/./g"          =  "http://a/g"
          "/../g"         =  "http://a/g"
          "g."            =  "http://a/b/c/g."
          ".g"            =  "http://a/b/c/.g"
          "g.."           =  "http://a/b/c/g.."
          "..g"           =  "http://a/b/c/..g"
        nonsense abs
            "./../g"        =  "http://a/b/g"
            "./g/."         =  "http://a/b/c/g/"
            "g/./h"         =  "http://a/b/c/g/h"
            "g/../h"        =  "http://a/b/c/h"
            "g;x=1/./y"     =  "http://a/b/c/g;x=1/y"
            "g;x=1/../y"    =  "http://a/b/c/y"
        no traverse from query
          "g?y/./x"       =  "http://a/b/c/g?y/./x"
          "g?y/../x"      =  "http://a/b/c/g?y/../x"
          "g#s/./x"       =  "http://a/b/c/g#s/./x"
          "g#s/../x"      =  "http://a/b/c/g#s/../x"
    */
    function resolveRelative(href, base) {
        var baseLocation = new Location(hashToHref(location.hash));
        var basePath = baseLocation.pathname + baseLocation.search + baseLocation.hash;
        var pathParts;
        //based on http://a/b/c/d;p?q

        //g:h -> g:h
        if (-1 != href.indexOf(':')) { //new scheme is always absolute.
            return href;
        }
        if (undefined === base) {
            if (location.protocol != "http:" && location.protocol != "https:") {
                log("resolving relative with unknown protocol" + location.protocol + " aborting.");
                return href;
            }
            base = (location.protocol + "//" +
                    location.hostname + (location.port ? ":" + location.port : "") +
                    basePath);
            //reconstruct with full information.
            baseLocation = new Location(base);
        }
        // starting with scheme, keep same protocol.
        if (href.substr(0,2) == "//") { // //foo.com -> http://foo.com
            return location.protocol + href;
        }

        //FIXME: loads not covered here yet.
        return href;

// Location shim 1.0
// (c) Jeremy Dunck
// MIT License

function Location(url) {
  obj = parseUri(url);
  this.hash = obj.anchor ? "#" + obj.anchor : "";
  this.host = obj.authority;
  this.hostname = obj.host;
  this.href = url;
  this.pathname = obj.path;
  this.port = obj.port;
  this.protocol = obj.protocol;
  this.search = obj.query ? "?" + obj.query : "";
  this.queryKey = obj.queryKey;
  this.toString = function() {
    return this.href;
  }
}

// parseUri 1.2.2
// (c) Steven Levithan <stevenlevithan.com>
// MIT License

function parseUri (str) {
  var o = parseUri.options,
    m   = o.parser[o.strictMode ? "strict" : "loose"].exec(str),
    uri = {},
    i   = 14;

  while (i--) uri[o.key[i]] = m[i] || "";

  uri[o.q.name] = {};
  uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
    if ($1) uri[o.q.name][$1] = $2;
  });

  return uri;
};

parseUri.options = {
  strictMode: false,
  key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"],
  q:   {
    name:   "queryKey",
    parser: /(?:^|&)([^&=]*)=?([^&]*)/g
  },
  parser: {
    strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
    loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
  }
};
        if (undefined === base) {
            base = hashToHref(location.hash);
        }
        console.warn("Fix relative resolution");
        return href;
    }
    function hrefToHash(href) {
        var abs = resolveRelative(href);
        var parts = abs.split("#");
        var subhash = parts[1] || "";
        return parts[0] + HASH_REPLACEMENT + encodeURIComponent(subhash);
    }
    function hashToHref(hash) {
        hash = (hash[0] === "#" ? hash.substr(1) : hash);
        var subhashIndex = hash.lastIndexOf(HASH_REPLACEMENT);
        var page, subhash;
        
        if (subhashIndex == -1) {
            return hash;
        } else {
            page = hash.substr(0,subhashIndex);
            subhash = decodeURIComponent(hash.substr(subhashIndex+1));
            return page + (subhash ? "#" + subhash : "");
        }
    }

    function Location(url) {

        // parseUri 1.2.2
        // (c) Steven Levithan <stevenlevithan.com>
        // MIT License

        function parseUri (str) {
            var o   = parseUri.options,
                m   = o.parser[o.strictMode ? "strict" : "loose"].exec(str),
                uri = {},
                i   = 14;

            while (i--) uri[o.key[i]] = m[i] || "";

            uri[o.q.name] = {};
            uri[o.key[12]].replace(o.q.parser, function ($0, $1, $2) {
                if ($1) uri[o.q.name][$1] = $2;
            });

            return uri;
        }

        parseUri.options = {
            strictMode: false,
            key: ["source","protocol","authority","userInfo","user","password","host","port","relative","path","directory","file","query","anchor"],
            q:   {
                name:   "queryKey",
                parser: /(?:^|&)([^&=]*)=?([^&]*)/g
            },
            parser: {
                strict: /^(?:([^:\/?#]+):)?(?:\/\/((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?))?((((?:[^?#\/]*\/)*)([^?#]*))(?:\?([^#]*))?(?:#(.*))?)/,
                loose:  /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/
            }
        };

        // end parseUri

        var parts = {
            port: '', // 80
            protocol: '', // http:
            hostname: '', // www.google.com
            pathname: '', // /search
            search: ''  // ?q=devmo
        };
        var that = this;
        var partFunc = function(k) {
            return function(value) {
                if (value === undefined) {
                    return parts[k];
                } else {
                    parts[k] = value;
                    return value;
                }
            };
        }
        for (var k in parts) {
            if (parts.hasOwnProperty(k)) {
                that[k] = partFunc(k);
            }
        }

        parts.hash = '';
        this.hash = function(value) { // #test
            if (value === undefined) {
                return parts.hash;
            } else {
                if (value.length === 0) {
                    parts.hash = '';
                } else {
                    parts.hash = value[0] === '#' ? value : '#' + value;
                }
                return parts.hash;
            }
        };
        this.href = function(value) {  // http://www.google.com:80/search?q=devmo#test
            if (value === undefined) {
                return this.protocol() + '//' + this.host() + this.pathname() + this.search() + this.hash();
            } else {
                var obj = parseUri(value);
                parts = {
                    port: obj.port,
                    protocol: obj.protocol + ':',
                    hostname: obj.host,
                    pathname: obj.path,
                    search: obj.query ? "?" + obj.query : "",
                    hash: obj.anchor ? "#" + obj.anchor : ""
                };
                return this.href();
            }
        };
        this.host = function(value) { // www.google.com:80
            if (value === undefined) {
                var host = this.hostname() + (this.port() === '' ? '' : ':' + this.port());
                return host;
            } else {
                var obj = parseUri(value + this.pathname() + this.search() + this.hash());
                parts.port = obj.port;
                parts.hostname = obj.host;
                return this.host();
            }
        };

        this.relativeHref = function() {
            return this.pathname() + this.search() + this.hash();
        }

        this.href(url); // hook it up!
    }

    methods = {
        init: function(explicitOpts) {
            activeOpts = $.extend(defaultOpts, explicitOpts);

            if (activeOpts.disabled) {
                // shortcut event binding
                return this;
            }

            document.write = activeOpts.onDocumentWrite;

            $(window).bind('hashchange', function(e){
                log('hashchange', e);
                updatePage({
                    url: hashToHref(location.hash),
                    type: 'GET'
                });
            });

            if (location.hash && location.hash !== '#') {
                log('existing hash', location.hash);
                updatePage({
                    url: hashToHref(location.hash),
                    type: 'GET'
                });
            }
            $('a:not(' + activeOpts.excludeSelector + ')').live('click', function() {
                location.hash = hrefToHash($(this).attr('href'));
                return false;
            });
            liveFormsSel = 'form:not(' + activeOpts.excludeSelector + ')';
            $(liveFormsSel).live('submit', function(event){
                if ($(this).has("input[type='file']").length) {
                    // we can't serialize files, so we have to do it the old-fashioned way
                    var action = $(this).attr('action') || '.';
                    if (action === '.') { // TODO: resolve all relative links, not just '.'
                        $(this).attr('action', hashToHref(location.hash));
                    }
                    return true;
                }

                var url = $(this).attr('action');
                var type = $(this).attr('method');
                var data = $(this).serialize();
                var submitter = this.submitter;
                if (submitter) {
                    data += (data.length === 0 ? "?" : "&") + (
                        encodeURIComponent($(submitter).attr("name")) 
                        + "=" + encodeURIComponent($(submitter).attr("value"))
                    );
                }
                log("form submission:", data);
                if (url === '.') {
                    url = hashToHref(location.hash);
                }
                if (type.toLowerCase() === 'get') {
                    url = url.substring(0, url.indexOf('?')) || url;
                    url += '?' + data;
                    location.hash = hrefToHash(url);
                } else {
                    // TODO: how does a post affect the hash fragment?
                    activeOpts.beforeUpdate();
                    updatePage({
                        url: url,
                        type: type,
                        data: data
                    });
                }
                return false;
            });
            //make sure the submitting button is included in the form data.
            $(liveFormsSel + " input[type=submit],button[type=submit]").live('click', function(event) {
              var form = $(this).closest("form").get(0);
              if (form) {
                form.submitter = this;
              }
            });
            return this;
        },
        hashchange: function(callback) { // callback = function(e, hash) { ... }
            $(window).bind('hashsignal.hashchange', callback);
            return this;
        },
        location: function(properties) {
            var that = {};
            $(properties).each(function(i, property) {
                that[property] = function(value) {
                    var l = new Location(hashToHref(location.hash));
                    if (!l) {
                        throw "Could not parse current location! " + hashToHref(location.hash);
                    }
                    if (value === undefined) {
                        return l[property]();
                    } else {
                        l[property](value);
                        location.hash = hrefToHash(l.relativeHref());
                    }
                }
            });

            that.assign = that.href; // alias to fully support window.location parity
            that.reload = function() {
                updatePage({
                    forceReload: true
                });
            };
            that.replace = function(url) {
                var l = new Location(url);
                location.replace('#' + hrefToHash(l.relativeHref()));
            };

            return that;
        }(['hash', 'href', 'pathname', 'search']),
        registerTransition: function(name, blockNames, opts) {
            log('hashsignal.registerTransition', name, blockNames);
            var transition = new Transition(opts);
            if (!!opts.alwaysReload) {
                blockNames = [ALWAYS_RELOAD];
            }
            for (var i = 0; i < blockNames.length; i++) {
                var blockName = blockNames[i];
                if (transitions[blockName] === undefined) {
                    transitions[blockName] = {};
                }
                if (transitions[blockName][name] === undefined) {
                    transitions[blockName][name] = transition;
                }
            }
            return this;
        },
        _unloadBlock: function(blockName) {
            log('hashsignal.unloadBlock', blockName);
            blockAction('unload', blockName);
        },
        _loadBlock: function(blockName) {
            log('hashsignal.loadBlock', blockName);
            blockAction('load', blockName);
        }
    };
    $.hashsignal = methods;
})(window, jQuery);

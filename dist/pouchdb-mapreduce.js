!function(e){"object"==typeof exports?module.exports=e():"function"==typeof define&&define.amd?define(e):"undefined"!=typeof window?window.mapReduce=e():"undefined"!=typeof global?global.mapReduce=e():"undefined"!=typeof self&&(self.mapReduce=e())}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var utils = require('./utils');
var upsert = require('./upsert');

module.exports = function (sourceDB, fullViewName, mapFun, reduceFun, cb) {
  sourceDB.info(function (err, info) {
    if (err) {
      return cb(err);
    }
    var PouchDB = sourceDB.constructor;

    var depDbName = info.db_name + '-mrview-' + PouchDB.utils.Crypto.MD5(
      mapFun.toString() + (reduceFun && reduceFun.toString()));

    // save the view name in the source PouchDB so it can be cleaned up if necessary
    // (e.g. when the _design doc is deleted, remove all associated view data)
    function diffFunction(doc) {
      doc.views = doc.views || {};
      doc.views[fullViewName] = doc.views[fullViewName] || {};
      doc.views[fullViewName][depDbName] = true;
      doc._deleted = false;
      return doc;
    }
    upsert(sourceDB, '_local/mrviews', diffFunction, function (err) {
      if (err) {
        return cb(err);
      }
      sourceDB.registerDependentDatabase(depDbName, function (err, res) {
        if (err) {
          return cb(err);
        }
        var db = res.db;
        var view = new View(depDbName, db, sourceDB, mapFun, reduceFun);
        view.db.get('_local/lastSeq', function (err, lastSeqDoc) {
          if (err) {
            if (err.name !== 'not_found') {
              return cb(err);
            } else {
              view.seq = 0;
            }
          } else {
            view.seq = lastSeqDoc.seq;
          }
          cb(null, view);
        });
      });
    });
  });
};

function View(name, db, sourceDB, mapFun, reduceFun) {
  this.db = db;
  this.name = name;
  this.sourceDB = sourceDB;
  this.adapter = sourceDB.adapter;
  this.mapFun = mapFun;
  this.reduceFun = reduceFun;
}
},{"./upsert":19,"./utils":20}],2:[function(require,module,exports){
'use strict';

module.exports = function (func, emit, sum, log, isArray, toJSON) {
  /*jshint evil: true */
  return eval("'use strict'; (" + func + ");");
};

},{}],3:[function(require,module,exports){
var process=require("__browserify_process"),global=typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {};'use strict';

var pouchCollate = require('pouchdb-collate');
var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');
var TaskQueue = require('./taskqueue');
var collate = pouchCollate.collate;
var toIndexableString = pouchCollate.toIndexableString;
var normalizeKey = pouchCollate.normalizeKey;
var createView = require('./create-view');
var evalFunc = require('./evalfunc');
var log = ((typeof console !== 'undefined') && (typeof console.log === 'function')) ?
  Function.prototype.bind.call(console.log, console) : function () {};
var utils = require('./utils');
var taskQueue = new TaskQueue();
taskQueue.registerTask('updateView', updateViewInner);
taskQueue.registerTask('queryView', queryViewInner);
taskQueue.registerTask('localViewCleanup', localViewCleanupInner);

var processKey = function (key) {
  // Stringify keys since we want them as map keys (see #35)
  return JSON.stringify(normalizeKey(key));
};

function tryCode(db, fun, args) {
  // emit an event if there was an error thrown by a map/reduce function.
  // putting try/catches in a single function also avoids deoptimizations.
  try {
    return {
      output : fun.apply(null, args)
    };
  } catch (e) {
    db.emit('error', e);
    return {error : e};
  }
}

function sliceResults(results, limit, skip) {
  skip = skip || 0;
  if (typeof limit === 'number') {
    return results.slice(skip, limit + skip);
  } else if (skip > 0) {
    return results.slice(skip);
  }
  return results;
}

function createKeysLookup(keys) {
  // creates a lookup map for the given keys, so that doing
  // query() with keys doesn't become an O(n * m) operation
  // lookup values are typically integer indexes, but may
  // map to a list of integers, since keys can be duplicated
  var lookup = {};

  for (var i = 0, len = keys.length; i < len; i++) {
    var key = processKey(keys[i]);
    var val = lookup[key];
    if (typeof val === 'undefined') {
      lookup[key] = i;
    } else if (typeof val === 'number') {
      lookup[key] = [val, i];
    } else { // array
      val.push(i);
    }
  }

  return lookup;
}

// standard sorting for emitted key/values
function sortByKeyIdValue(a, b) {
  var keyCompare = collate(a.key, b.key);
  if (keyCompare !== 0) {
    return keyCompare;
  }
  var idCompare = collate(a.id, b.id);
  return idCompare !== 0 ? idCompare : collate(a.value, b.value);
}
function addAtIndex(idx, result, prelimResults) {
  var val = prelimResults[idx];
  if (typeof val === 'undefined') {
    prelimResults[idx] = result;
  } else if (!Array.isArray(val)) {
    // same key for multiple docs, need to preserve document order, so create array
    prelimResults[idx] = [val, result];
  } else { // existing array
    val.push(result);
  }
}

function sum(values) {
  return values.reduce(function (a, b) {
    return a + b;
  }, 0);
}

var builtInReduce = {
  "_sum": function (keys, values) {
    return sum(values);
  },

  "_count": function (keys, values) {
    return values.length;
  },

  "_stats": function (keys, values) {
    // no need to implement rereduce=true, because Pouch
    // will never call it
    function sumsqr(values) {
      var _sumsqr = 0;
      var error;
      for (var idx in values) {
        if (typeof values[idx] === 'number') {
          _sumsqr += values[idx] * values[idx];
        } else {
          error = new Error('builtin _stats function requires map values to be numbers');
          error.name = 'invalid_value';
          error.status = 500;
          return error;
        }
      }
      return _sumsqr;
    }
    return {
      sum     : sum(values),
      min     : Math.min.apply(null, values),
      max     : Math.max.apply(null, values),
      count   : values.length,
      sumsqr : sumsqr(values)
    };
  }
};

function addHttpParam(paramName, opts, params, asJson) {
  // add an http param from opts to params, optionally json-encoded
  var val = opts[paramName];
  if (typeof val !== 'undefined') {
    if (asJson) {
      val = encodeURIComponent(JSON.stringify(val));
    }
    params.push(paramName + '=' + val);
  }
}

function mapUsingKeys(inputResults, keys, keysLookup) {
  // create a new results array from the given array,
  // ensuring that the following conditions are respected:
  // 1. docs are ordered by key, then doc id
  // 2. docs can appear >1 time in the list, if their key is specified >1 time
  // 3. keys can be unknown, in which case there's just a hole in the returned array

  var prelimResults = new Array(keys.length);

  inputResults.forEach(function (result) {
    var idx = keysLookup[processKey(result.key)];
    if (typeof idx === 'number') {
      addAtIndex(idx, result, prelimResults);
    } else { // array of indices
      idx.forEach(function (subIdx) {
        addAtIndex(subIdx, result, prelimResults);
      });
    }
  });

  // flatten the array, remove nulls, sort by doc ids
  var outputResults = [];
  prelimResults.forEach(function (result) {
    if (Array.isArray(result)) {
      outputResults = outputResults.concat(result.sort(sortByKeyIdValue));
    } else { // single result
      outputResults.push(result);
    }
  });

  return outputResults;
}

function checkQueryParseError(options, fun) {
  var startkeyName = options.descending ? 'endkey' : 'startkey';
  var endkeyName = options.descending ? 'startkey' : 'endkey';

  if (typeof options[startkeyName] !== 'undefined' &&
    typeof options[endkeyName] !== 'undefined' &&
    collate(options[startkeyName], options[endkeyName]) > 0) {
    return new QueryParseError('No rows can match your key range, reverse your ' +
        'start_key and end_key or set {descending : true}');
  } else if (fun.reduce && options.reduce !== false && options.include_docs) {
    return new QueryParseError('{include_docs:true} is invalid for reduce');
  }
}

function viewQuery(db, fun, options) {
  var origMap;
  if (!options.skip) {
    options.skip = 0;
  }

  if (!fun.reduce) {
    options.reduce = false;
  }

  var startkeyName = options.descending ? 'endkey' : 'startkey';
  var endkeyName = options.descending ? 'startkey' : 'endkey';

  var results = [];
  var current;
  var num_started = 0;
  var completed = false;
  var keysLookup;

  var totalRows = 0;

  function emit(key, val) {

    totalRows++;

    var viewRow = {
      id: current.doc._id,
      key: pouchCollate.normalizeKey(key),
      value: pouchCollate.normalizeKey(val)
    };

    if (typeof options[startkeyName] !== 'undefined' && collate(key, options[startkeyName]) < 0) {
      return;
    }
    if (typeof options[endkeyName] !== 'undefined' && collate(key, options[endkeyName]) > 0) {
      return;
    }
    if (typeof options.key !== 'undefined' && collate(key, options.key) !== 0) {
      return;
    }
    if (typeof options.keys !== 'undefined') {
      keysLookup = keysLookup || createKeysLookup(options.keys);
      if (typeof keysLookup[processKey(key)] === 'undefined') {
        return;
      }
    }

    num_started++;
    if (options.include_docs) {
      //in this special case, join on _id (issue #106)
      if (val && typeof val === 'object' && val._id) {
        db.get(val._id,
          function (_, joined_doc) {
            if (joined_doc) {
              viewRow.doc = joined_doc;
            }
            results.push(viewRow);
            checkComplete();
          });
        return;
      } else {
        viewRow.doc = current.doc;
      }
    }
    results.push(viewRow);
  }
  if (typeof fun.map === "function" && fun.map.length === 2) {
    //save a reference to it
    origMap = fun.map;
    fun.map = function (doc) {
      //call it with the emit as the second argument
      return origMap(doc, emit);
    };
  } else {
    // ugly way to make sure references to 'emit' in map/reduce bind to the
    // above emit
    fun.map = evalFunc(fun.map.toString(), emit, sum, log, Array.isArray, JSON.parse);
  }
  if (fun.reduce) {
    if (builtInReduce[fun.reduce]) {
      fun.reduce = builtInReduce[fun.reduce];
    } else {
      fun.reduce = evalFunc(fun.reduce.toString(), emit, sum, log, Array.isArray, JSON.parse);
    }
  }

  function returnMapResults() {
    if (options.descending) {
      results.reverse();
    }
    return options.complete(null, {
      total_rows: totalRows,
      offset: options.skip,
      rows: sliceResults(results, options.limit, options.skip)
    });
  }

  var mapError;

  //only proceed once all documents are mapped and joined
  function checkComplete() {

    var error;

    if (completed && (mapError || results.length === num_started)) {
      if (typeof options.keys !== 'undefined' && results.length) {
        // user supplied a keys param, sort by keys
        results = mapUsingKeys(results, options.keys, keysLookup);
      } else { // normal sorting
        results.sort(sortByKeyIdValue);
      }

      if (options.reduce === false) {
        return returnMapResults();
      }

      // TODO: actually implement group/group_level
      var shouldGroup = options.group || options.group_level;

      var groups = [];
      results.forEach(function (e) {
        var last = groups[groups.length - 1];
        var key = shouldGroup ? e.key : null;
        if (last && collate(last.key[0][0], key) === 0) {
          last.key.push([key, e.id]);
          last.value.push(e.value);
          return;
        }
        groups.push({key: [
          [key, e.id]
        ], value: [e.value]});
      });
      var reduceError;
      groups.forEach(function (e) {
        if (reduceError) {
          return;
        }
        var reduceTry = tryCode(db, fun.reduce, [e.key, e.value, false]);
        if (reduceTry.error) {
          reduceError = true;
        } else {
          e.value = reduceTry.output;
        }
        if (e.value.sumsqr && e.value.sumsqr instanceof Error) {
          error = e.value;
          return;
        }
        e.key = e.key[0][0];
      });
      if (reduceError) {
        returnMapResults();
        return;
      }
      if (error) {
        options.complete(error);
        return;
      }
      if (options.descending) {
        groups.reverse();
      }
      // no total_rows/offset when reducing
      options.complete(null, {
        rows : sliceResults(groups, options.limit, options.skip)
      });
    }
  }


  db.changes({
    conflicts: true,
    include_docs: true,
    onChange: function (doc) {
      if (!('deleted' in doc) && doc.id[0] !== "_" && !mapError) {
        current = {doc: doc.doc};
        var mapTry = tryCode(db, fun.map, [doc.doc]);
        if (mapTry.error) {
          mapError = true;
        }
      }
    },
    complete: function () {
      completed = true;
      checkComplete();
    }
  });
}

function httpQuery(db, fun, opts) {
  var callback = opts.complete;

  // List of parameters to add to the PUT request
  var params = [];
  var body;
  var method = 'GET';

  // If opts.reduce exists and is defined, then add it to the list
  // of parameters.
  // If reduce=false then the results are that of only the map function
  // not the final result of map and reduce.
  addHttpParam('reduce', opts, params);
  addHttpParam('include_docs', opts, params);
  addHttpParam('limit', opts, params);
  addHttpParam('descending', opts, params);
  addHttpParam('group', opts, params);
  addHttpParam('group_level', opts, params);
  addHttpParam('skip', opts, params);
  addHttpParam('startkey', opts, params, true);
  addHttpParam('endkey', opts, params, true);
  addHttpParam('key', opts, params, true);

  // If keys are supplied, issue a POST request to circumvent GET query string limits
  // see http://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
  if (typeof opts.keys !== 'undefined') {
    method = 'POST';
    if (typeof fun === 'string') {
      body = JSON.stringify({keys: opts.keys});
    } else { // fun is {map : mapfun}, so append to this
      fun.keys = opts.keys;
    }
  }

  // Format the list of parameters into a valid URI query string
  params = params.join('&');
  params = params === '' ? '' : '?' + params;

  // We are referencing a query defined in the design doc
  if (typeof fun === 'string') {
    var parts = fun.split('/');
    db.request({
      method: method,
      url: '_design/' + parts[0] + '/_view/' + parts[1] + params,
      body: body
    }, callback);
    return;
  }

  // We are using a temporary view, terrible for performance but good for testing
  var queryObject = JSON.parse(JSON.stringify(fun, function (key, val) {
    if (typeof val === 'function') {
      return val + ''; // implicitly `toString` it
    }
    return val;
  }));

  db.request({
    method: 'POST',
    url: '_temp_view' + params,
    body: queryObject
  }, callback);
}

function destroyView(viewName, adapter, PouchDB, cb) {
  PouchDB.destroy(viewName, {adapter : adapter}, function (err) {
    if (err) {
      return cb(err);
    }
    return cb(null);
  });
}

function saveKeyValues(view, indexableKeysToKeyValues, docId, seq, cb) {

  view.db.get('_local/lastSeq', function (err, lastSeqDoc) {
    if (err) {
      if (err.name !== 'not_found') {
        return cb(err);
      } else {
        lastSeqDoc = {
          _id : '_local/lastSeq',
          seq : 0
        };
      }
    }

    view.db.get('_local/doc_' + docId, function (err, metaDoc) {
      if (err) {
        if (err.name !== 'not_found') {
          return cb(err);
        } else {
          metaDoc = {
            _id : '_local/doc_' + docId,
            keys : []
          };
        }
      }
      view.db.allDocs({keys : metaDoc.keys, include_docs : true}, function (err, res) {
        if (err) {
          return cb(err);
        }
        var kvDocs = res.rows.map(function (row) {
          return row.doc;
        }).filter(function (row) {
            return row;
          });

        var oldKeysMap = {};
        kvDocs.forEach(function (kvDoc) {
          oldKeysMap[kvDoc._id] = true;
          kvDoc._deleted = !indexableKeysToKeyValues[kvDoc._id];
          if (!kvDoc._deleted) {
            kvDoc.value = indexableKeysToKeyValues[kvDoc._id];
          }
        });

        var newKeys = Object.keys(indexableKeysToKeyValues);
        newKeys.forEach(function (key) {
          if (!oldKeysMap[key]) {
            // new doc
            kvDocs.push({
              _id : key,
              value : indexableKeysToKeyValues[key]
            });
          }
        });
        metaDoc.keys = utils.uniq(newKeys.concat(metaDoc.keys));
        kvDocs.push(metaDoc);

        lastSeqDoc.seq = seq;
        kvDocs.push(lastSeqDoc);

        view.db.bulkDocs({docs : kvDocs}, function (err) {
          if (err) {
            return cb(err);
          }
          cb(null);
        });
      });
    });
  });
}

function updateView(view, cb) {
  taskQueue.addTask(view.sourceDB, 'updateView', [view, cb]);
  taskQueue.execute();
}

function updateViewInner(view, cb) {
  // bind the emit function once
  var indexableKeysToKeyValues;
  var emitCounter;
  var doc;

  function emit(key, value) {
    var indexableStringKey = toIndexableString([key, doc._id, value, emitCounter++]);
    indexableKeysToKeyValues[indexableStringKey] = {
      id  : doc._id,
      key : normalizeKey(key),
      value : normalizeKey(value)
    };
  }

  var mapFun = evalFunc(view.mapFun.toString(), emit, sum, log, Array.isArray, JSON.parse);

  var reduceFun;
  if (view.reduceFun) {
    reduceFun = builtInReduce[view.reduceFun] ||
      evalFunc(view.reduceFun.toString(), emit, sum, log, Array.isArray, JSON.parse);
  }

  var lastSeq = view.seq;
  var gotError;
  var complete;
  var numStarted = 0;
  var numFinished = 0;
  function checkComplete() {
    if (!gotError && complete && numStarted === numFinished) {
      view.seq = lastSeq;
      cb(null);
    }
  }

  function processChange(changeInfo, cb) {
    if (changeInfo.id[0] === '_') {
      numFinished++;
      return cb(null);
    }

    indexableKeysToKeyValues = {};
    emitCounter = 0;
    doc = changeInfo.doc;

    if (!('deleted' in changeInfo)) {
      tryCode(view.sourceDB, mapFun, [changeInfo.doc]);
    }
    saveKeyValues(view, indexableKeysToKeyValues, changeInfo.id, changeInfo.seq, function (err) {
      if (err) {
        return cb(err);
      } else {
        lastSeq = Math.max(lastSeq, changeInfo.seq);
        numFinished++;
        cb(null);
      }
    });
  }
  var queue = new TaskQueue();
  queue.registerTask('processChange', processChange);

  view.sourceDB.changes({
    conflicts: true,
    include_docs: true,
    since : view.seq,
    onChange: function (doc) {
      numStarted++;
      queue.addTask(view.sourceDB, 'processChange', [doc, function (err) {
        if (err && !gotError) {
          gotError = err;
          return cb(err);
        }
        checkComplete();
      }]);
      queue.execute();
    },
    complete: function () {
      complete = true;
      checkComplete();
    }
  });
}

function reduceView(view, results, options, cb) {
  // we already have the reduced output persisted in the database,
  // so we only need to rereduce

  // TODO: actually implement group/group_level
  var shouldGroup = options.group || options.group_level;

  var reduceFun;
  if (builtInReduce[view.reduceFun]) {
    reduceFun = builtInReduce[view.reduceFun];
  } else {
    reduceFun = evalFunc(
      view.reduceFun.toString(), null, sum, log, Array.isArray, JSON.parse);
  }

  var error;
  var groups = [];
  results.forEach(function (e) {
    var last = groups[groups.length - 1];
    var key = shouldGroup ? e.key : null;
    if (last && collate(last.key[0][0], key) === 0) {
      last.key.push([key, e.id]);
      last.value.push(e.value);
      return;
    }
    groups.push({key: [
      [key, e.id]
    ], value: [e.value]});
  });
  for (var i = 0, len = groups.length; i < len; i++) {
    var e = groups[i];
    var reduceTry = tryCode(view.sourceDB, reduceFun, [e.key, e.value, false]);
    if (reduceTry.error) {
      return reduceTry;
    } else {
      e.value = reduceTry.output;
    }
    if (e.value.sumsqr && e.value.sumsqr instanceof Error) {
      error = e.value;
    }
    e.key = e.key[0][0];
  }
  if (error) {
    return cb(error);
  }
  // no total_rows/offset when reducing
  cb(null, {
    rows: sliceResults(groups, options.limit, options.skip)
  });
}

function queryView(view, opts, cb) {
  taskQueue.addTask(view.sourceDB, 'queryView', [view, opts, cb]);
  taskQueue.execute();
}

function queryViewInner(view, opts, cb) {
  var totalRows;
  var shouldReduce = view.reduceFun && opts.reduce !== false;
  var skip = opts.skip || 0;
  if (typeof opts.keys !== 'undefined' && !opts.keys.length) {
    // equivalent query
    opts.limit = 0;
    delete opts.keys;
  }

  function fetchFromView(viewOpts, cb) {
    viewOpts.include_docs = true;
    view.db.allDocs(viewOpts, function (err, res) {
      if (err) {
        return cb(err);
      }
      totalRows = res.total_rows;
      var resultValues = res.rows.map(function (result) {
        return result.doc.value;
      });
      cb(null, resultValues);
    });
  }

  function onMapResultsReady(results) {
    if (shouldReduce) {
      var reduceResult = reduceView(view, results, opts, cb);
      if (!(reduceResult && reduceResult.error)) {
        return;
      } // in case of reduce error, map results are returned
    }
    results.forEach(function (result) {
      delete result.reduceOutput;
    });
    var onComplete = function () {
      cb(null, {
        total_rows : totalRows,
        offset : skip,
        rows : results
      });
    };
    if (opts.include_docs && results.length) {
      // fetch and attach documents
      var numDocsFetched = 0;
      results.forEach(function (viewRow) {
        var val = viewRow.value;
        //in this special case, join on _id (issue #106)
        var dbId = (val && typeof val === 'object' && val._id) || viewRow.id;
        view.sourceDB.get(dbId, function (_, joined_doc) {
          if (joined_doc) {
            viewRow.doc = joined_doc;
          }
          if (++numDocsFetched === results.length) {
            onComplete();
          }
        });
      });
    } else { // don't need the docs
      onComplete();
    }

  }

  if (typeof opts.keys !== 'undefined') {
    var keysLookup = createKeysLookup(opts.keys);
    var keysLookupLen = Object.keys(keysLookup).length;
    var results = new Array(opts.keys.length);
    var numKeysFetched = 0;
    var keysError;
    Object.keys(keysLookup).forEach(function (key) {
      var keysLookupIndices = keysLookup[key];
      var trueKey = JSON.parse(key);
      var viewOpts = {
        startkey : toIndexableString([trueKey]),
        endkey   : toIndexableString([trueKey, {}])
      };
      fetchFromView(viewOpts, function (err, subResults) {
        if (err) {
          keysError = true;
          return cb(err);
        } else if (keysError) {
          return;
        } else if (typeof keysLookupIndices === 'number') {
          results[keysLookupIndices] = subResults;
        } else { // array of indices
          keysLookupIndices.forEach(function (i) {
            results[i] = subResults;
          });
        }
        if (++numKeysFetched === keysLookupLen) {
          // combine results
          var combinedResults = [];
          results.forEach(function (result) {
            combinedResults = combinedResults.concat(result);
          });

          if (!shouldReduce) {
            // since we couldn't skip/limit before, do so now
            combinedResults = sliceResults(combinedResults, opts.limit, skip);
          }
          onMapResultsReady(combinedResults);
        }
      });
    });
  } else { // normal query, no 'keys'
    var viewOpts = {
      descending : opts.descending
    };
    if (typeof opts.startkey !== 'undefined') {
      viewOpts.startkey = opts.descending ?
        toIndexableString([opts.startkey, {}]) :
        toIndexableString([opts.startkey]);
    }
    if (typeof opts.endkey !== 'undefined') {
      viewOpts.endkey = opts.descending ?
        toIndexableString([opts.endkey]) :
        toIndexableString([opts.endkey, {}]);
    }
    if (typeof opts.key !== 'undefined') {
      var keyStart = toIndexableString([opts.key]);
      var keyEnd = toIndexableString([opts.key, {}]);
      if (viewOpts.descending) {
        viewOpts.endkey = keyStart;
        viewOpts.startkey = keyEnd;
      } else {
        viewOpts.startkey = keyStart;
        viewOpts.endkey = keyEnd;
      }
    }
    if (!shouldReduce) {
      if (typeof opts.limit === 'number') {
        viewOpts.limit = opts.limit;
      }
      viewOpts.skip = skip;
    }
    fetchFromView(viewOpts, function (err, results) {
      if (err) {
        return cb(err);
      }
      onMapResultsReady(results);
    });
  }
}

function httpViewCleanup(db, cb) {
  db.request({
    method: 'POST',
    url: '_view_cleanup'
  }, cb);
}

function localViewCleanup(db, callback) {
  taskQueue.addTask(db, 'localViewCleanup', [db, callback]);
  taskQueue.execute();
}

function localViewCleanupInner(db, callback) {
  db.get('_local/mrviews', function (err, metaDoc) {
    if (err && err.name !== 'not_found') {
      return callback(err);
    } else if (metaDoc && metaDoc.views) {
      var docsToViews = {};
      Object.keys(metaDoc.views).forEach(function (fullViewName) {
        var parts = fullViewName.split('/');
        var designDocName = '_design/' + parts[0];
        var viewName = parts[1];
        docsToViews[designDocName] = docsToViews[designDocName] || {};
        docsToViews[designDocName][viewName] = true;
      });
      var opts = {
        keys : Object.keys(docsToViews),
        include_docs : true
      };
      db.allDocs(opts, function (err, res) {
        if (err) {
          return callback(err);
        }
        var numStarted = 0;
        var numDone = 0;
        var gotError;
        function checkDone() {
          if (numStarted === numDone) {
            if (gotError) {
              return callback(gotError);
            }
            callback(null, {ok : true});
          }
        }
        var viewsToStatus = {};
        res.rows.forEach(function (row) {
          Object.keys(docsToViews[row.key]).forEach(function (viewName) {
            var viewDBNames = Object.keys(metaDoc.views[row.key.substring(8) + '/' + viewName]);
            // design doc deleted, or view function nonexistent
            var statusIsGood = row.doc && row.doc.views && row.doc.views[viewName];
            viewDBNames.forEach(function (viewDBName) {
              viewsToStatus[viewDBName] = viewsToStatus[viewDBName] || statusIsGood;
            });
          });
        });
        var dbsToDelete = Object.keys(viewsToStatus).filter(function (viewDBName) {
          return !viewsToStatus[viewDBName];
        });
        if (!dbsToDelete.length) {
          return callback(null, {ok : true});
        }
        utils.uniq(dbsToDelete).forEach(function (viewDBName) {
          numStarted++;

          destroyView(viewDBName, db.adapter, db.constructor, function (err) {
            if (err) {
              gotError = err;
            }
            numDone++;
            checkDone();
          });
        });
        taskQueue.execute();
      });
    } else {
      return callback(null, {ok : true});
    }
  });
}

exports.viewCleanup = function (origCallback) {
  var db = this;
  var realCB;
  if (origCallback) {
    realCB = function (err, resp) {
      process.nextTick(function () {
        origCallback(err, resp);
      });
    };
  }
  var promise = new Promise(function (resolve, reject) {
    function callback(err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    }

    if (db.type() === 'http') {
      return httpViewCleanup(db, callback);
    }

    return localViewCleanup(db, callback);
  });

  if (realCB) {
    promise.then(function (resp) {
      realCB(null, resp);
    }, realCB);
  }
  return promise;
};

exports.query = function (fun, opts, callback) {
  var db = this;
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = utils.clone(opts || {});
  if (callback) {
    opts.complete = callback;
  }
  var tempCB = opts.complete;
  var realCB;
  if (opts.complete) {
    realCB = function (err, resp) {
      process.nextTick(function () {
        tempCB(err, resp);
      });
    };
  } 
  var promise = new Promise(function (resolve, reject) {
    opts.complete = function (err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    };

    if (typeof fun === 'object') {
      // copy to avoid overwriting
      var funCopy = {};
      Object.keys(fun).forEach(function (key) {
        funCopy[key] = fun[key];
      });
      fun = funCopy;
    }

    if (db.type() === 'http') {
      if (typeof fun === 'function') {
        return httpQuery(db, {map: fun}, opts);
      }
      return httpQuery(db, fun, opts);
    }

    if (typeof fun === 'function') {
      fun = {map : fun};
    }

    var parseError = checkQueryParseError(opts, fun);
    if (parseError) {
      return opts.complete(parseError);
    }

    if (typeof fun !== 'string') {
      return viewQuery(db, fun, opts);
    }

    var fullViewName = fun;
    var parts = fullViewName.split('/');
    var designDocName = parts[0];
    var viewName = parts[1];
    db.get('_design/' + designDocName, function (err, doc) {
      if (err) {
        opts.complete(err);
        return;
      }

      var fun = doc.views && doc.views[viewName];

      if (!fun || typeof fun.map !== 'string') {
        opts.complete({ name: 'not_found', message: 'missing_named_view' });
        return;
      }
      var parseError = checkQueryParseError(opts, fun);
      if (parseError) {
        return opts.complete(parseError);
      }

      createView(db, fullViewName, fun.map, fun.reduce, function (err, view) {
        if (err) {
          return opts.complete(err);
        } else if (opts.stale === 'ok' || opts.stale === 'update_after') {
          if (opts.stale === 'update_after') {
            updateView(view, function (err) {
              if (err) {
                view.sourceDB.emit('error', err);
              }
            });
          }
          queryView(view, opts, opts.complete);
        } else { // stale not ok
          return updateView(view, function (err) {
            if (err) {
              return opts.complete(err);
            }
            queryView(view, opts, opts.complete);
          });
        }
      });
    });
  });
  if (realCB) {
    promise.then(function (resp) {
      realCB(null, resp);
    }, realCB);
  }
  return promise;
};

function QueryParseError(message) {
  this.status = 400;
  this.name = 'query_parse_error';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, QueryParseError);
  } catch (e) {}
}

utils.inherits(QueryParseError, Error);

},{"./create-view":1,"./evalfunc":2,"./taskqueue":18,"./utils":20,"__browserify_process":4,"lie":6,"pouchdb-collate":16}],4:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],5:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],6:[function(require,module,exports){
'use strict';

var immediate = require('immediate');
var isDefineProp = false;
// prevents deoptimization
(function(){
    try {
        Object.defineProperty({}, 'test', {value:true});
        isDefineProp = true;
    }catch(e){}
}());
function defineNonEnum(obj, name, value){
    if(isDefineProp){
         Object.defineProperty(obj, name, {
            value: value,
            configurable: true,
            writable: true
        });
    }else{
        obj[name] = value;
    }
}
function Promise(resolver) {

     if (!(this instanceof Promise)) {
        return new Promise(resolver);
    }

    defineNonEnum(this, 'successQueue', []);
    defineNonEnum(this, 'failureQueue', []);
    defineNonEnum(this, 'resolved', false);

  
    if(typeof resolver === 'function'){
        this.resolvePassed(resolver);
    }
}
defineNonEnum(Promise.prototype, 'resolvePassed', function(resolver){
    try{
        resolver(this.fulfillUnwrap.bind(this),this.reject.bind(this));
    }catch(e){
        this.reject(e);
    }
});
defineNonEnum(Promise.prototype, 'reject', function(reason){
    this.resolve(false,reason);
});
defineNonEnum(Promise.prototype, 'fulfill', function(value){
    this.resolve(true,value);
});
defineNonEnum(Promise.prototype, 'fulfillUnwrap', function(value){
    unwrap(this.fulfill.bind(this), this.reject.bind(this), value);
});
Promise.prototype.then = function(onFulfilled, onRejected) {
    if(this.resolved){
        return this.resolved(onFulfilled, onRejected);
    } else {
        return this.pending(onFulfilled, onRejected);
    }
};
(function(){
    try {
        Promise.prototype.catch = function(onRejected) {
            return this.then(null, onRejected);
        };
    } catch(e){}
}());
defineNonEnum(Promise.prototype, 'pending', function(onFulfilled, onRejected){
    var self = this;
    return new Promise(function(success,failure){
        if(typeof onFulfilled === 'function'){
            self.successQueue.push({
                resolve: success,
                reject: failure,
                callback:onFulfilled
            });
        }else{
            self.successQueue.push({
                next: success,
                callback:false
            });
        }

        if(typeof onRejected === 'function'){
            self.failureQueue.push({
                resolve: success,
                reject: failure,
                callback:onRejected
            });
        }else{
            self.failureQueue.push({
                next: failure,
                callback:false
            });
        }
    });
});
defineNonEnum(Promise.prototype, 'resolve', function (success, value){

    if(this.resolved){
        return;
    }

    this.resolved = createResolved(this, value, success?0:1);

    var queue = success ? this.successQueue : this.failureQueue;
    var len = queue.length;
    var i = -1;
    while(++i < len) {

        if (queue[i].callback) {
            immediate(execute,queue[i].callback, value, queue[i].resolve, queue[i].reject);
        }else {
            queue[i].next(value);
        }
    }
});

function unwrap(fulfill, reject, value){
    if(value && typeof value.then==='function'){
        value.then(fulfill,reject);
    }else{
        fulfill(value);
    }
}

function createResolved(scope, value, whichArg) {
    function resolved() {
        var callback = arguments[whichArg];
        if (typeof callback !== 'function') {
            return scope;
        }else{
            return new Promise(function(resolve,reject){
                immediate(execute,callback,value,resolve,reject);
            });
        }
    }
    return resolved;
}

function execute(callback, value, resolve, reject) {
    try {
        unwrap(resolve,reject,callback(value));
    } catch (error) {
        reject(error);
    }
}



module.exports = Promise;

},{"immediate":9}],7:[function(require,module,exports){
"use strict";
exports.test = function () {
    return false;
};
},{}],8:[function(require,module,exports){
var global=typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {};module.exports = typeof global === "object" && global ? global : this;
},{}],9:[function(require,module,exports){
"use strict";
var types = [
    require("./nextTick"),
    require("./mutation"),
    require("./realSetImmediate"),
    require("./postMessage"),
    require("./messageChannel"),
    require("./stateChange"),
    require("./timeout")
];
var handlerQueue = [];
function drainQueue() {
    var i = 0,
        task,
        innerQueue = handlerQueue;
	handlerQueue = [];
	/*jslint boss: true */
	while (task = innerQueue[i++]) {
		task();
	}
}
var nextTick;
var i = -1;
var len = types.length;
while(++i<len){
    if(types[i].test()){
        nextTick = types[i].install(drainQueue);
        break;
    }
}
var retFunc = function (task) {
    var len, args;
    var nTask = task;
    if (arguments.length > 1 && typeof task === "function") {
        args = Array.prototype.slice.call(arguments, 1);
        nTask = function(){
            task.apply(undefined,args);
        }
    }
    if ((len = handlerQueue.push(nTask)) === 1) {
        nextTick(drainQueue);
    }
    return len;
};
retFunc.clear = function (n) {
    if (n <= handlerQueue.length) {
        handlerQueue[n - 1] = function () {};
    }
    return this;
};
module.exports = retFunc;

},{"./messageChannel":10,"./mutation":11,"./nextTick":7,"./postMessage":12,"./realSetImmediate":13,"./stateChange":14,"./timeout":15}],10:[function(require,module,exports){
"use strict";
var globe = require("./global");
exports.test = function () {
    return !!globe.MessageChannel;
};

exports.install = function (func) {
    var channel = new globe.MessageChannel();
    channel.port1.onmessage = func;
    return function () {
        channel.port2.postMessage(0);
    };
};
},{"./global":8}],11:[function(require,module,exports){
"use strict";
//based off rsvp
//https://github.com/tildeio/rsvp.js/blob/master/lib/rsvp/async.js
var globe = require("./global");

var MutationObserver = globe.MutationObserver || globe.WebKitMutationObserver;

exports.test = function () {
    return MutationObserver;
};

exports.install = function (handle) {
    var observer = new MutationObserver(handle);
    var element = globe.document.createElement("div");
    observer.observe(element, { attributes: true });

    // Chrome Memory Leak: https://bugs.webkit.org/show_bug.cgi?id=93661
    globe.addEventListener("unload", function () {
        observer.disconnect();
        observer = null;
    }, false);
    return function () {
        element.setAttribute("drainQueue", "drainQueue");
    };
};
},{"./global":8}],12:[function(require,module,exports){
"use strict";
var globe = require("./global");
exports.test = function () {
    // The test against `importScripts` prevents this implementation from being installed inside a web worker,
    // where `global.postMessage` means something completely different and can"t be used for this purpose.

    if (!globe.postMessage || globe.importScripts) {
        return false;
    }

    var postMessageIsAsynchronous = true;
    var oldOnMessage = globe.onmessage;
    globe.onmessage = function () {
        postMessageIsAsynchronous = false;
    };
    globe.postMessage("", "*");
    globe.onmessage = oldOnMessage;

    return postMessageIsAsynchronous;
};

exports.install = function (func) {
    var codeWord = "com.calvinmetcalf.setImmediate" + Math.random();
    function globalMessage(event) {
        if (event.source === globe && event.data === codeWord) {
            func();
        }
    }
    if (globe.addEventListener) {
        globe.addEventListener("message", globalMessage, false);
    } else {
        globe.attachEvent("onmessage", globalMessage);
    }
    return function () {
        globe.postMessage(codeWord, "*");
    };
};
},{"./global":8}],13:[function(require,module,exports){
"use strict";
var globe = require("./global");
exports.test = function () {
    return  globe.setImmediate;
};

exports.install = function (handle) {
    return globe.setTimeout.bind(globe, handle, 0);
};

},{"./global":8}],14:[function(require,module,exports){
"use strict";
var globe = require("./global");
exports.test = function () {
    return "document" in globe && "onreadystatechange" in globe.document.createElement("script");
};

exports.install = function (handle) {
    return function () {

        // Create a <script> element; its readystatechange event will be fired asynchronously once it is inserted
        // into the document. Do so, thus queuing up the task. Remember to clean up once it's been called.
        var scriptEl = globe.document.createElement("script");
        scriptEl.onreadystatechange = function () {
            handle();

            scriptEl.onreadystatechange = null;
            scriptEl.parentNode.removeChild(scriptEl);
            scriptEl = null;
        };
        globe.document.documentElement.appendChild(scriptEl);

        return handle;
    };
};
},{"./global":8}],15:[function(require,module,exports){
"use strict";
exports.test = function () {
    return true;
};

exports.install = function (t) {
    return function () {
        setTimeout(t, 0);
    };
};
},{}],16:[function(require,module,exports){
'use strict';

var MIN_MAGNITUDE = -324; // verified by -Number.MIN_VALUE
var MAGNITUDE_DIGITS = 3; // ditto
var SEP = '_'; // TODO: in production it should be empty

var utils = require('./utils');

exports.collate = function (a, b) {
  a = exports.normalizeKey(a);
  b = exports.normalizeKey(b);
  var ai = collationIndex(a);
  var bi = collationIndex(b);
  if ((ai - bi) !== 0) {
    return ai - bi;
  }
  if (a === null) {
    return 0;
  }
  if (typeof a === 'number') {
    return a - b;
  }
  if (typeof a === 'boolean') {
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  if (typeof a === 'string') {
    return stringCollate(a, b);
  }
  if (Array.isArray(a)) {
    return arrayCollate(a, b);
  }
  return objectCollate(a, b);
};

// couch considers null/NaN/Infinity/-Infinity === undefined,
// for the purposes of mapreduce indexes. also, dates get stringified.
exports.normalizeKey = function (key) {
  if (typeof key === 'undefined') {
    return null;
  } else if (typeof key === 'number') {
    if (key === Infinity || key === -Infinity || isNaN(key)) {
      return null;
    }
  } else if (key instanceof Date) {
    return key.toJSON();
  }
  return key;
};

// convert the given key to a string that would be appropriate
// for lexical sorting, e.g. within a database, where the
// sorting is the same given by the collate() function.
exports.toIndexableString = function (key) {
  var zero = '\u0000';

  key = exports.normalizeKey(key);

  var result = collationIndex(key) + SEP;

  if (key !== null) {
    if (typeof key === 'boolean') {
      result += (key ? 1 : 0);
    } else if (typeof key === 'number') {
      result += numToIndexableString(key) + zero;
    } else if (typeof key === 'string') {
      // We've to be sure that key does not contain \u0000
      // Do order-preserving replacements:
      // 0 -> 1, 1
      // 1 -> 1, 2
      // 2 -> 2, 2
      key = key.replace(/\u0002/g, '\u0002\u0002');
      key = key.replace(/\u0001/g, '\u0001\u0002');
      key = key.replace(/\u0000/g, '\u0001\u0001');

      result += key + zero;
    } else if (Array.isArray(key)) {
      key.forEach(function (element) {
        result += exports.toIndexableString(element);
      });
      result += zero;
    } else if (typeof key === 'object') {
      var arr = [];
      var keys = Object.keys(key);
      keys.forEach(function (objKey) {
        arr.push([objKey, key[objKey]]);
      });
      result += exports.toIndexableString(arr);
    }
  }

  return result;
};

function arrayCollate(a, b) {
  var len = Math.min(a.length, b.length);
  for (var i = 0; i < len; i++) {
    var sort = exports.collate(a[i], b[i]);
    if (sort !== 0) {
      return sort;
    }
  }
  return (a.length === b.length) ? 0 :
    (a.length > b.length) ? 1 : -1;
}
function stringCollate(a, b) {
  // See: https://github.com/daleharvey/pouchdb/issues/40
  // This is incompatible with the CouchDB implementation, but its the
  // best we can do for now
  return (a === b) ? 0 : ((a > b) ? 1 : -1);
}
function objectCollate(a, b) {
  var ak = Object.keys(a), bk = Object.keys(b);
  var len = Math.min(ak.length, bk.length);
  for (var i = 0; i < len; i++) {
    // First sort the keys
    var sort = exports.collate(ak[i], bk[i]);
    if (sort !== 0) {
      return sort;
    }
    // if the keys are equal sort the values
    sort = exports.collate(a[ak[i]], b[bk[i]]);
    if (sort !== 0) {
      return sort;
    }

  }
  return (ak.length === bk.length) ? 0 :
    (ak.length > bk.length) ? 1 : -1;
}
// The collation is defined by erlangs ordered terms
// the atoms null, true, false come first, then numbers, strings,
// arrays, then objects
// null/undefined/NaN/Infinity/-Infinity are all considered null
function collationIndex(x) {
  var id = ['boolean', 'number', 'string', 'object'];
  var idx = id.indexOf(typeof x);
  //false if -1 otherwise true, but fast!!!!1
  if (~idx) {
    if (x === null) {
      return 1;
    }
    if (Array.isArray(x)) {
      return 5;
    }
    return idx < 3 ? (idx + 2) : (idx + 3);
  }
  if (Array.isArray(x)) {
    return 5;
  }
}

// conversion:
// x yyy zz...zz
// x = 0 for negative, 1 for 0, 2 for positive
// y = exponent (for negative numbers negated) moved so that it's >= 0
// z = mantisse
function numToIndexableString(num) {

  // convert number to exponential format for easier and
  // more succinct string sorting
  var expFormat = num.toExponential().split(/e\+?/);
  var magnitude = parseInt(expFormat[1], 10);

  var neg = num < 0;

  if (num === 0) {
    return '1';
  }

  var result = neg ? '0' : '2';

  // first sort by magnitude
  // it's easier if all magnitudes are positive
  var magForComparison = ((neg ? -magnitude : magnitude) - MIN_MAGNITUDE);
  var magString = utils.padLeft((magForComparison).toString(), '0', MAGNITUDE_DIGITS);

  result += SEP + magString;

  // then sort by the factor
  var factor = Math.abs(parseFloat(expFormat[0])); // [1..10)
  if (neg) { // for negative reverse ordering
    factor = 10 - factor;
  }

  var factorStr = factor.toFixed(20);

  // strip zeros from the end
  factorStr = factorStr.replace(/\.?0+$/, '');

  result += SEP + factorStr;

  return result;
}

},{"./utils":17}],17:[function(require,module,exports){
'use strict';

function pad(str, padWith, upToLength) {
  var padding = '';
  var targetLength = upToLength - str.length;
  while (padding.length < targetLength) {
    padding += padWith;
  }
  return padding;
}

exports.padLeft = function (str, padWith, upToLength) {
  var padding = pad(str, padWith, upToLength);
  return padding + str;
};

exports.padRight = function (str, padWith, upToLength) {
  var padding = pad(str, padWith, upToLength);
  return str + padding;
};

exports.stringLexCompare = function (a, b) {

  var aLen = a.length;
  var bLen = b.length;

  var i;
  for (i = 0; i < aLen; i++) {
    if (i === bLen) {
      // b is shorter substring of a
      return 1;
    }
    var aChar = a.charAt(i);
    var bChar = b.charAt(i);
    if (aChar !== bChar) {
      return aChar < bChar ? -1 : 1;
    }
  }

  if (aLen < bLen) {
    // a is shorter substring of b
    return -1;
  }

  return 0;
};

/*
 * returns the decimal form for the given integer, i.e. writes
 * out all the digits (in base-10) instead of using scientific notation
 */
exports.intToDecimalForm = function (int) {

  var isNeg = int < 0;
  var result = '';

  do {
    var remainder = isNeg ? -Math.ceil(int % 10) : Math.floor(int % 10);

    result = remainder + result;
    int = isNeg ? Math.ceil(int / 10) : Math.floor(int / 10);
  } while (int);


  if (isNeg && result !== '0') {
    result = '-' + result;
  }

  return result;
};
},{}],18:[function(require,module,exports){
'use strict';
/*
 * Simple task queue to sequentialize actions. Assumes callbacks will eventually fire (once).
 */

module.exports = TaskQueue;

function TaskQueue() {
  this.isReady = true;
  this.queue = [];
  this.registeredTasks = {};
}

TaskQueue.prototype.registerTask = function (name, func) {
  this.registeredTasks[name] = func;
};

TaskQueue.prototype.execute = function () {
  var self = this;

  if (self.isReady && self.queue.length) {
    var task = self.queue.shift();
    var oldCB = task.parameters[task.parameters.length - 1];
    task.parameters[task.parameters.length - 1] = function (err, res) {
      oldCB.call(this, err, res);
      self.isReady = true;
      self.execute();
    };
    self.isReady = false;
    self.callTask(task);
  }
};

TaskQueue.prototype.callTask = function (task) {
  var self = this;
  try {
    self.registeredTasks[task.name].apply(null, task.parameters);
  } catch (err) {
    // unexpected error, bubble up if they're not handling the emitted 'error' event
    self.isReady = true;
    task.emitter.emit('error', err);
  }
};

TaskQueue.prototype.addTask = function (emitter, name, parameters) {
  var task = { name: name, parameters: parameters, emitter : emitter };
  this.queue.push(task);
  return task;
};
},{}],19:[function(require,module,exports){
var global=typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {};'use strict';
var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
function upsert(db, docId, diffFun) {
  return new Promise(function (fullfil, reject) {
    if (docId && typeof docId === 'object') {
      docId = docId._id;
    }
    if (typeof docId !== 'string') {
      return reject(new Error('doc id is required'));
    }

    db.get(docId, function (err, doc) {
      if (err) {
        if (err.name !== 'not_found') {
          return reject(err);
        }
        return fullfil(tryAndPut(db, diffFun({_id : docId}), diffFun));
      }
      doc = diffFun(doc);
      fullfil(tryAndPut(db, doc, diffFun));
    });
  });
}

function tryAndPut(db, doc, diffFun) {
  return db.put(doc).then(null, function (err) {
    if (err.name !== 'conflict') {
      throw err;
    }
    return upsert(db, doc, diffFun);
  });
}

module.exports = function (db, docId, diffFun, cb) {
  if (typeof cb === 'function') {
    upsert(db, docId, diffFun).then(function (resp) {
      cb(null, resp);
    }, cb);
  } else {
    return upsert(db, docId, diffFun);
  }
};

},{"lie":6}],20:[function(require,module,exports){
'use strict';

// uniquify a list, similar to underscore's _.uniq
exports.uniq = function (arr) {
  var map = {};
  arr.forEach(function (element) {
    map[element] = true;
  });
  return Object.keys(map);
};

// shallow clone an object
exports.clone = function (obj) {
  if (typeof obj !== 'object') {
    return obj;
  }
  var result = {};
  Object.keys(obj).forEach(function (key) {
    result[key] = obj[key];
  });
  return result;
};

exports.inherits = require('inherits');
},{"inherits":5}]},{},[3])
(3)
});
;
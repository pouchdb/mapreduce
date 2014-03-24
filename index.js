'use strict';

var pouchCollate = require('pouchdb-collate');
var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');
var TaskQueue = require('./taskqueue');
var collate = pouchCollate.collate;
var toIndexableString = pouchCollate.toIndexableString;
var normalizeKey = pouchCollate.normalizeKey;
var createView = require('./create-view');
var evalFunc = require('./evalfunc');
var log = (typeof console !== 'undefined') ?
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

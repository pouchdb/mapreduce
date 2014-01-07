'use strict';

var pouchCollate = require('pouchdb-collate');

// This is the first implementation of a basic plugin, we register the
// plugin object with pouch and it is mixin'd to each database created
// (regardless of adapter), adapters can override plugins by providing
// their own implementation. functions on the plugin object that start
// with _ are reserved function that are called by pouchdb for special
// notifications.

// If we wanted to store incremental views we can do it here by listening
// to the changes feed (keeping track of our last update_seq between page loads)
// and storing the result of the map function (possibly using the upcoming
// extracted adapter functions)

function normalize(key) {
  // couch considers null === undefined for the purposes of mapreduce indexes
  return typeof key === 'undefined' ? null : key;
}
function MapReduceError(name, msg, code) {
  this.name = name;
  this.message = msg;
  this.status =  code;
}
MapReduceError.prototype = new Error();
function createKeysLookup(keys) {
  // creates a lookup map for the given keys, so that doing
  // query() with keys doesn't become an O(n * m) operation
  // lookup values are typically integer indexes, but may
  // map to a list of integers, since keys can be duplicated
  var lookup = {};

  for (var i = 0, len = keys.length; i < len; i++) {
    var key = normalize(keys[i]);
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

function sortByIdAndValue(a, b) {
  // sort by id, then value
  var idCompare = pouchCollate(a.id, b.id);
  return idCompare !== 0 ? idCompare : pouchCollate(a.value, b.value);
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

  "_count": function (keys, values, rereduce) {
    return values.length;
  },

  "_stats": function (keys, values) {
    return {
      'sum': sum(values),
      'min': Math.min.apply(null, values),
      'max': Math.max.apply(null, values),
      'count': values.length,
      'sumsqr': (function () {
        var _sumsqr = 0;
        for (var idx in values) {
          if (typeof values[idx] === 'number') {
            _sumsqr += values[idx] * values[idx];
          } else {
            return new MapReduceError(
              'builtin _stats function requires map values to be numbers',
              'invalid_value',
              500
            );
          }
        }
        return _sumsqr;
      })()
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

function MapReduce(db) {
  if (!(this instanceof MapReduce)) {
    return new MapReduce(db);
  }

  function mapUsingKeys(inputResults, keys, keysLookup) {
    // create a new results array from the given array,
    // ensuring that the following conditions are respected:
    // 1. docs are ordered by key, then doc id
    // 2. docs can appear >1 time in the list, if their key is specified >1 time
    // 3. keys can be unknown, in which case there's just a hole in the returned array

    var prelimResults = new Array(keys.length);

    inputResults.forEach(function (result) {
      var idx = keysLookup[normalize(result.key)];
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
        outputResults = outputResults.concat(result.sort(sortByIdAndValue));
      } else { // single result
        outputResults.push(result);
      }
    });

    return outputResults;
  }

  function viewQuery(fun, options) {
    /*jshint evil: true */

    if (!options.skip) {
      options.skip = 0;
    }

    if (!fun.reduce) {
      options.reduce = false;
    }

    var results = [];
    var current;
    var num_started = 0;
    var completed = false;
    var keysLookup;

    function emit(key, val) {
      var viewRow = {
        id: current.doc._id,
        key: key,
        value: val
      };

      if (typeof options.startkey !== 'undefined' && pouchCollate(key, options.startkey) < 0) {
        return;
      }
      if (typeof options.endkey !== 'undefined' && pouchCollate(key, options.endkey) > 0) {
        return;
      }
      if (typeof options.key !== 'undefined' && pouchCollate(key, options.key) !== 0) {
        return;
      }
      if (typeof options.keys !== 'undefined') {
        keysLookup = keysLookup || createKeysLookup(options.keys);
        if (typeof keysLookup[normalize(key)] === 'undefined') {
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
    // ugly way to make sure references to 'emit' in map/reduce bind to the
    // above emit

    eval('fun.map = ' + fun.map.toString() + ';');
    if (fun.reduce) {
      if (builtInReduce[fun.reduce]) {
        fun.reduce = builtInReduce[fun.reduce];
      } else {
        eval('fun.reduce = ' + fun.reduce.toString() + ';');
      }
    }

    //only proceed once all documents are mapped and joined
    function checkComplete() {
      var error;
      if (completed && results.length === num_started) {

        if (typeof options.keys !== 'undefined' && results.length) {
          // user supplied a keys param, sort by keys
          results = mapUsingKeys(results, options.keys, keysLookup);
        } else { // normal sorting
          results.sort(function (a, b) {
            // sort by key, then id
            var keyCollate = pouchCollate(a.key, b.key);
            return keyCollate !== 0 ? keyCollate : pouchCollate(a.id, b.id);
          });
        }
        if (options.descending) {
          results.reverse();
        }
        if (options.reduce === false) {
          return options.complete(null, {
            total_rows: results.length,
            offset: options.skip,
            rows: ('limit' in options) ? results.slice(options.skip, options.limit + options.skip) :
              (options.skip > 0) ? results.slice(options.skip) : results
          });
        }

        var groups = [];
        results.forEach(function (e) {
          var last = groups[groups.length - 1];
          if (last && pouchCollate(last.key[0][0], e.key) === 0) {
            last.key.push([e.key, e.id]);
            last.value.push(e.value);
            return;
          }
          groups.push({key: [
            [e.key, e.id]
          ], value: [e.value]});
        });
        groups.forEach(function (e) {
          e.value = fun.reduce(e.key, e.value);
          if (e.value.sumsqr && e.value.sumsqr instanceof MapReduceError) {
            error = e.value;
            return;
          }
          e.key = e.key[0][0];
        });
        if (error) {
          options.complete(error);
          return;
        }
        options.complete(null, {
          total_rows: groups.length,
          offset: options.skip,
          rows: ('limit' in options) ? groups.slice(options.skip, options.limit + options.skip) :
            (options.skip > 0) ? groups.slice(options.skip) : groups
        });
      }
    }

    db.changes({
      conflicts: true,
      include_docs: true,
      onChange: function (doc) {
        if (!('deleted' in doc) && doc.id[0] !== "_") {
          current = {doc: doc.doc};
          fun.map.call(this, doc.doc);
        }
      },
      complete: function () {
        completed = true;
        checkComplete();
      }
    });
  }

  function httpQuery(fun, opts) {
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

  this.query = function (fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (callback) {
      opts.complete = callback;
    }

    if (typeof opts.complete !== 'function') {
      throw new Error('Need a callback');
    }

    if (db.type() === 'http') {
      if (typeof fun === 'function') {
        return httpQuery({map: fun}, opts);
      }
      return httpQuery(fun, opts);
    }

    if (typeof fun === 'object') {
      return viewQuery(fun, opts);
    }

    if (typeof fun === 'function') {
      return viewQuery({map: fun}, opts);
    }

    var parts = fun.split('/');
    db.get('_design/' + parts[0], function (err, doc) {
      if (err) {
        opts.complete(err);
        return;
      }

      if (!doc.views[parts[1]]) {
        opts.complete({ name: 'not_found', message: 'missing_named_view' });
        return;
      }
      viewQuery({
        map: doc.views[parts[1]].map,
        reduce: doc.views[parts[1]].reduce
      }, opts);
    });
  };
}

// Deletion is a noop since we dont store the results of the view
MapReduce._delete = function () {
};
module.exports = MapReduce;

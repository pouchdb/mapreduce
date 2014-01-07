/*global Pouch: true, pouchCollate: true */

"use strict";

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

function normalize(key) {  // couch considers null === undefined for the purposes of mapreduce indexes
  return typeof key === 'undefined' ? null : key;
}

function sortById(a, b) {
  return pouchCollate(a.id, b.id);
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
  return values.reduce(function (a, b) { return a + b; }, 0);
}

var builtInReduce = {
  "_sum": function (keys, values){
    return sum(values);
  },

  "_count": function (keys, values, rereduce){
    if (rereduce){
      return sum(values);
    } else {
      return values.length;
    }
  },

  "_stats": function (keys, values, rereduce) {
    return {
      'sum': sum(values),
      'min': Math.min.apply(null, values),
      'max': Math.max.apply(null, values),
      'count': values.length,
      'sumsqr': (function () {
        var _sumsqr = 0;
        for(var idx in values) {
          if (typeof values[idx] === 'number') {
            _sumsqr += values[idx] * values[idx];
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
function rebuildResults(inputResults, keysLookup, idsLookup) {
  // create a new results array from the given array,
  // ensuring that the following conditions are respected:
  // 1. docs are ordered by key, then doc id
  // 2. docs can appear >1 time in the list, if their key is specified >1 time
  // 3. keys can be unknown, in which case there's just a hole in the returned array
  var keys = Object.keys(keysLookup);
  keys.sort(function(a,b){
    return pouchCollate(keysLookup[a].key, keysLookup[b].key);
  });
  var prelimResults = [];

  keys.forEach(function(key){
    var values = keysLookup[key]
    values.start = prelimResults.length;
    var indexes = Object.keys(values.ids);
    indexes.sort(function(a,b){
      return pouchCollate(values.ids[a].doc,values.ids[b].doc);
    });
    var newIds = {};
    indexes.forEach(function(oldIndex){
      var value = values.ids[oldIndex];
      var newIndex = prelimResults.length;
      idsLookup[value.doc].keys[key] = newIndex;
      newIds[newIndex] = {id:newIndex,doc:value.doc};
      prelimResults[newIndex] = inputResults[oldIndex]
    });
    values.ids = newIds;
    keysLookup[key] = values;
  });

  return {
    results:prelimResults,
    keysLookup:keysLookup,
    idsLookup:idsLookup
  }
}
function check(results, details, keysLookup, idLookup, cb) {
  if (details.completed && results.length === details.started){
    cb(rebuildResults(results, keysLookup, idLookup));
  }
}
function buildIndices(db, fun, details, done){
    var results = [];
    var current;
    
    var keyLookup = {};
    var idLookup = {};

    function emit(key, val) {
      key = normalize(key);
      var jKey = JSON.stringify(key);
      var viewRow = {
        id: current.doc._id,
        key: key,
        value: val,
        doc: current.doc
      };
      details.started++;
      if (val && typeof val === 'object' && val._id){
        db.get(val._id,
            function (_, joined_doc){
              if (joined_doc) {
                viewRow.doc = joined_doc;
              }
              var currentIndex = results.length;
              if(!keyLookup[jKey]){
                keyLookup[jKey] = {ids:{},key:key};
              }
              keyLookup[jKey].ids[currentIndex] ={id:currentIndex,doc:current.doc._id};
              if(!idLookup[current.doc._id]){
                idLookup[current.doc._id] = {keys:{},doc:current.doc};
              }
              if(typeof idLookup[current.doc._id].keys[jKey] === 'undefined'){
                idLookup[current.doc._id].keys[jKey] = currentIndex;
              }
              results.push(viewRow);
              check(results, details, keyLookup, idLookup, done);
            });
        return;
      }
      var currentIndex = results.length;
      if(!keyLookup[jKey]){
        keyLookup[jKey] = {ids:{},key:key};
      }
      keyLookup[jKey].ids[currentIndex] ={id:currentIndex,doc:current.doc._id};
      if(!idLookup[current.doc._id]){
        idLookup[current.doc._id] = {keys:[],doc:current.doc};
      }
      if(typeof idLookup[current.doc._id].keys[jKey] === 'undefined'){
        idLookup[current.doc._id].keys[jKey] = currentIndex;
      }
      results.push(viewRow);
    };

    // ugly way to make sure references to 'emit' in map/reduce bind to the
    // above emit
    eval('fun.map = ' + fun.map.toString() + ';');
    if (fun.reduce) {
      if (builtInReduce[fun.reduce]) {
        fun.reduce = builtInReduce[fun.reduce];
      }

      eval('fun.reduce = ' + fun.reduce.toString() + ';');
    }
    db.changes({
      conflicts: true,
      include_docs: true,
      onChange: function (doc) {
        if (!('deleted' in doc)) {
          current = {doc: doc.doc};
          fun.map.call(this, doc.doc);
        }
      },
      complete: function () {
        details.completed= true;
        check(results, details, keyLookup, idLookup, done);
      }
    });
}
function MapReduce(db) {
  if(!(this instanceof MapReduce)){
    return new MapReduce(db);
  }


  function viewQuery(fun, options) {
    options = options||{};
    if (!options.complete) {
      return;
    }

    if (!options.skip) {
      options.skip = 0;
    }

    if (!fun.reduce) {
      options.reduce = false;
    }
    var details = {started :0,completed:false};
    buildIndices(db,fun,details, buildQuarry);

    //only proceed once all documents are mapped and joined
    function buildQuarry(resultsObj) {
        var start = 0;
        var results;
        var totalRows = resultsObj.results.length;
        if('startkey' in options){
          Object.keys(resultsObj.keysLookup).sort(function(a,b){
              return pouchCollate(resultsObj.keysLookup[a].key, resultsObj.keysLookup[b].key);
            }).every(function(key){
            if(pouchCollate(resultsObj.keysLookup[key].key, options.startkey) < 0){
              return true;
            }else{
              start = resultsObj.keysLookup[key].start;
              return false;
            }
          });
        }
        if('key' in options && JSON.stringify(options.key) in resultsObj.keysLookup){
          results = Object.keys(resultsObj.keysLookup[JSON.stringify(options.key)].ids).map(function(v){
            return resultsObj.results[resultsObj.keysLookup[JSON.stringify(options.key)].ids[v].id];
          });
        }else if(options.keys){
          results = [];
          options.keys.forEach(function(key){
            var jKey = JSON.stringify(key);
            if(!resultsObj.keysLookup[jKey]){
              return;
            }
            results = results.concat(Object.keys(resultsObj.keysLookup[jKey].ids).map(function(v){
              return resultsObj.results[resultsObj.keysLookup[jKey].ids[v].id];
            }));
          });
        }else if('endkey' in options){
          Object.keys(resultsObj.keysLookup).sort(function(a,b){
              return pouchCollate(resultsObj.keysLookup[a].key, resultsObj.keysLookup[b].key);
            }).every(function(key,i,list){
            if(pouchCollate(resultsObj.keysLookup[key].key, options.endkey) <= 0){
              return true;
            }else{
              results = resultsObj.results.slice(start, resultsObj.keysLookup[key].start);
              return false;
            }
          });
          if(!Array.isArray(results)){
            results = resultsObj.results.slice(start);
          }
        }else if(start){
          results = resultsObj.results.slice(start);
        }else{
          results = resultsObj.results;
        }
        if (options.descending) {
          results.reverse();
        }
        if(!options.include_docs){
          results.forEach(function(row){
            delete row.doc;
          });
        }
        if (options.reduce === false) {
          return options.complete(null, {
            total_rows: totalRows,
            offset: options.skip,
            rows: ('limit' in options) ? results.slice(options.skip, options.limit + options.skip) :
              (options.skip > 0) ? results.slice(options.skip) : results
          });
        }

        var groups = [];
        results.forEach(function (e) {
          var last = groups[groups.length-1] || null;
          if (last && pouchCollate(last.key[0][0], e.key) === 0) {
            last.key.push([e.key, e.id]);
            last.value.push(e.value);
            return;
          }
          groups.push({key: [[e.key, e.id]], value: [e.value]});
        });
        groups.forEach(function (e) {
          e.value = fun.reduce(e.key, e.value);
          e.value = (typeof e.value === 'undefined') ? null : e.value;
          e.key = e.key[0][0];
        });

        options.complete(null, {
          total_rows: groups.length,
          offset: options.skip,
          rows: ('limit' in options) ? groups.slice(options.skip, options.limit + options.skip) :
            (options.skip > 0) ? groups.slice(options.skip) : groups
        });
    };
  }

  function httpQuery(fun, opts, callback) {

    // List of parameters to add to the PUT request
    var params = [];
    var body = undefined;
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
        body = JSON.stringify({keys:opts.keys});
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
      method:'POST',
      url: '_temp_view' + params,
      body: queryObject
    }, callback);
  }

  this.query = function(fun, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (callback) {
      opts.complete = callback;
    }

    if (db.type() === 'http') {
    if (typeof fun === 'function'){
      return httpQuery({map: fun}, opts, callback);
    }
    return httpQuery(fun, opts, callback);
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
        if (callback) callback(err);
        return;
      }

      if (!doc.views[parts[1]]) {
        if (callback) callback({ name: 'not_found', message: 'missing_named_view' });
        return;
      }

      viewQuery({
        map: doc.views[parts[1]].map,
        reduce: doc.views[parts[1]].reduce
      }, opts);
    });
  }

};

// Deletion is a noop since we dont store the results of the view
MapReduce._delete = function () { };
module.exports = MapReduce;

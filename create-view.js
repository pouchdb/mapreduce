'use strict';

var upsert = require('./upsert');
var utils = require('./utils');
var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');

module.exports = function (opts) {
  var sourceDB = opts.db;
  var viewName = opts.viewName;
  var mapFun = opts.map;
  var reduceFun = opts.reduce;
  var randomizer = opts.randomizer;

  var viewSignature = mapFun.toString() + (reduceFun && reduceFun.toString()) +
    (randomizer && randomizer.toString());

  if (sourceDB._cachedViews) {
    var cachedView = sourceDB._cachedViews[viewSignature];
    if (cachedView) {
      return Promise.resolve(cachedView);
    }
  }

  return sourceDB.info().then(function (info) {
    var depDbName = info.db_name + '-mrview-' + utils.MD5(viewSignature);

    // save the view name in the source PouchDB so it can be cleaned up if necessary
    // (e.g. when the _design doc is deleted, remove all associated view data)
    function diffFunction(doc) {
      doc.views = doc.views || {};
      var depDbs = doc.views[viewName] = doc.views[viewName] || {};

      if (depDbs[depDbName]) {
        return false; // no update necessary
      }
      depDbs[depDbName] = true;
      return doc;
    }
    return upsert(sourceDB, '_local/mrviews', diffFunction).then(function () {
      return sourceDB.registerDependentDatabase(depDbName).then(function (res) {
        var db = res.db;
        db.auto_compaction = true;
        var view = new View(depDbName, db, sourceDB, mapFun, reduceFun);
        return view.db.get('_local/lastSeq').then(null, function (err) {
          if (err.name === 'not_found') {
            return 0;
          }
          throw err;
        }).then(function (lastSeqDoc) {
          view.seq = lastSeqDoc.seq;

          if (!randomizer) {
            // randomizer implies the view is temporary, no need to cache it
            sourceDB._cachedViews = sourceDB._cachedViews || {};
            sourceDB._cachedViews[viewSignature] = view;
            view.db.on('destroyed', function () {
              delete sourceDB._cachedViews[viewSignature];
            });
          }
          return view;
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

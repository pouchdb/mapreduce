'use strict';

var utils = require('./utils');
var upsert = require('./upsert');

module.exports = function (sourceDB, fullViewName, name, mapFun, reduceFun, cb) {
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

'use strict';

var utils = require('./utils');

module.exports = function (sourceDB, fullViewName, mapFun, reduceFun, cb) {
  sourceDB.info(function (err, info) {
    if (err) {
      return cb(err);
    }
    var PouchDB = sourceDB.constructor;

    var name = info.db_name + '-mrview-' + PouchDB.utils.Crypto.MD5(mapFun.toString() +
      (reduceFun && reduceFun.toString()));

    // save the view name in the source PouchDB so it can be cleaned up if necessary
    // (e.g. when the _design doc is deleted, remove all associated view data)
    function diffFunction(doc) {
      doc.views = doc.views || {};
      doc.views[fullViewName] = doc.views[fullViewName] || {};
      doc.views[fullViewName][name] = true;
      doc._deleted = false;
      return doc;
    }
    utils.retryUntilWritten(sourceDB, '_local/mrviews', diffFunction, function (err) {
      if (err) {
        return cb(err);
      }
      var pouchOpts = {
        adapter : sourceDB.adapter
      };
      new PouchDB(name, pouchOpts, function (err, db) {
        if (err) {
          return cb(err);
        }
        var view = new View(name, db, sourceDB, mapFun, reduceFun);
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

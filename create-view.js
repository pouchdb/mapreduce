'use strict';

var utils = require('./utils');

module.exports = function (sourceDB, fullViewName, mapFun, reduceFun) {
  var PouchDB = sourceDB.constructor;
  return sourceDB.info().then(function (info) {
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
    return utils.retryUntilWritten(sourceDB, '_local/mrviews', diffFunction).then(function () {
      var pouchOpts = {
        adapter : sourceDB.adapter
      };
      return new PouchDB(name, pouchOpts);
    }).then(function (db) {
      var view = new View(name, db, sourceDB, mapFun, reduceFun);

      return view.db.get('_local/lastSeq').then(null, function (err) {
        if (err.name === 'not_found') {
          return 0;
        }
        throw err;
      }).then(function (lastSeqDoc) {
        view.seq = lastSeqDoc.seq;
        return view;
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

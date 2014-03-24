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

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
exports.retryUntilWritten = function (db, docId, diffFun, cb) {
  db.get(docId, function (err, doc) {
    if (err) {
      if (err.name !== 'not_found') {
        return cb(err);
      }
      return tryAndPut(db, diffFun({_id : docId}), diffFun, cb);
    }
    doc = diffFun(doc);
    tryAndPut(db, doc, diffFun, cb);
  });
};

function tryAndPut(db, doc, diffFun, cb) {
  db.put(doc, function (err) {
    if (err) {
      if (err.name !== 'conflict') {
        return cb(err);
      }
      return exports.retryUntilWritten(db, doc, diffFun, cb);
    }
    cb(null);
  });
}
'use strict';
/*
 * Simple task queue to sequentialize actions. Assumes callbacks will eventually fire (once).
 */

var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');

function TaskQueue() {
  this.promise = new Promise(function (fulfill) {fulfill(); });
}
TaskQueue.prototype.add = function (promiseFactory) {
  this.promise = this.promise.then(null, function () {
    // just recover
  }).then(function () {
    return promiseFactory();
  });
  return this.promise;
};
TaskQueue.prototype.finish = function () {
  return this.promise;
};

module.exports = TaskQueue;

'use strict';
/*
 * Simple task queue to sequentialize actions. Assumes callbacks will eventually fire (once).
 */

var Promise = typeof global.Promise === 'function' ? global.Promise : require('lie');

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

function TaskQueue2() {
  this.promise = new Promise(function (fulfill) {fulfill();});
}
TaskQueue2.prototype.add = function (promiseFactory) {
  this.promise = this.promise.then(function () {
    return promiseFactory();
  });
  return this.promise;
};
TaskQueue2.prototype.finish = function () {
  return this.promise;
};

module.exports = {};
module.exports.TaskQueue = TaskQueue;
module.exports.TaskQueue2 = TaskQueue2;

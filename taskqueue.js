'use strict';
/*
 * Simple task queue to sequentialize actions. Assumes callbacks will eventually fire (once).
 */
module.exports = TaskQueue;

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
    try {
      self.registeredTasks[task.name].apply(null, task.parameters);
    } catch (err) {
      console.log('totally unexpected err');
      console.log(err);
      self.isReady = true;
    }
  }
};

TaskQueue.prototype.addTask = function (name, parameters) {
  var task = { name: name, parameters: parameters };
  this.queue.push(task);
  return task;
};
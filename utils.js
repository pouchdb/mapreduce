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
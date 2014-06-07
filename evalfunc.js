'use strict';

var noeval = require('./noeval');

function evalIt(func, emit, sum, log, isArray, toJSON) {
  /*jshint evil:true,unused:false */
  return eval("'use strict'; (" + func.replace(/;\s*$/, "") + ");");
}

module.exports = function (func, emit, sum, log, isArray, toJSON) {
  try {
    return evalIt(func, emit, sum, log, isArray, toJSON);
  } catch (err) {
    if (err instanceof EvalError) {
      // this gets thrown in Chrome package apps, so try to fall back to parsing
      return noeval(func, emit);
    }
    throw err;
  }
};

// uncomment this to test using noeval everywhere
//module.exports = noeval;
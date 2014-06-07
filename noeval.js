// module for parsing common map functions so we don't have to use eval
// designed to get the basic tests passing in Chrome apps and other
// environments where eval is disallowed

'use strict';

var coreRegex = new RegExp(
  '^\\s*function\\s*\\(' +       // function
    '([^,)]+)?' +                 // doc
    '(?:,[^,)]+)?' +             // second arg after doc, e.g. emit
    '\\)\\s*{\\s*' +
    '(?:if\\s*\\(([^\\)]+)\\)' + // optional condition
    '[\\s*{]+)?\\s*emit\\(' +
    '([^,\\(]+)?' +               // emitted key
    '(?:,\\s*([^\\)]+)\\s*)?' +  // optional emitted value
    '\\)[;\\s}]+$');

var joinedDocRegex = new RegExp(
  '\\s*{\\s*[\'"]?_id[\'"]?\\s*:\\s*([^}]+)}'
);

var numberRegex = new RegExp(
  '^[\\d\\.e]+$'
);

var conditionRegex = new RegExp(
  '\\s*([^\\s=!<>]+)\\s*(===|==|<|<=|>=|>|!=|!==)\\s*([^\\s=!<>]+)\\s*'
);

function tryJson(str) {
  try {
    return JSON.parse(str);
  } catch (err) {
    return undefined;
  }
}

function parseSubElement(el, docName) {
  var match;
  if (docName && el === docName) {
    // whole doc
    return {
      type: 'wholeDoc'
    };
  } else if (docName && el.substring(0, docName.length) === docName) {
    if (el.charAt(docName.length) === '.') {
      // simple field member like doc.foo
      return {
        type: 'field',
        field: el.substring(docName.length + 1)
      };
    } else { // assume doc['foo bar']
      return {
        type: 'field',
        field: el.substring(docName.length + 1, el.length - 1)
      };
    }
  } else if (el.charAt(0) === "'" || el.charAt(0) === '"') {
    // simple string like 'foo' or "bar"
    return {
      type: 'constant',
      value: el.substring(1, el.length - 1)
    };
  } else if (el.match(numberRegex)) {
    return parseFloat(el);
  } else if (el === 'undefined') {
    return undefined;
  } else if ((match = el.match(joinedDocRegex))) {
    var joinedDocVal = match[1];
    return {
      type: 'joinedVal',
      value: parseSubElement(joinedDocVal, docName)
    };
  } else {
    var json = tryJson(el);
    if (typeof json !== 'undefined') {
      return json;
    }
  }
  throw new Error('unknown sub element: ' + el);
}

function parseElement(el, docName) {
  if (!el) {
    return undefined;
  } else if (el.substring(0, 2) === '!!') {
    return {
      type: 'coerce',
      boolean: true,
      value: parseSubElement(el.substring(2), docName)
    }; // e.g. !!doc.name
  } else if (el.substring(0, 1) === '!') {
    return {
      type: 'coerce',
      boolean: false,
      value: parseSubElement(el.substring(1), docName)
    }; // e.g. !doc.name
  } else {
    return parseSubElement(el, docName);
  }
}

function parseCondition(str, docName) {
  if (!str) {
    return undefined;
  }
  var match = str.match(conditionRegex);
  if (!match) {
    // bare condition, like if (doc.foo)
    return {
      type: 'simple',
      value: parseElement(str, docName)
    };
  }
  var left = match[1];
  var right = match[3];
  var operator = match[2];
  return {
    type: 'expression',
    left: parseElement(left, docName),
    right: parseElement(right, docName),
    operator: operator
  };
}

function evalExpressionCondition(condition, doc) {

  var left = evalValue(condition.left, doc);
  var right = evalValue(condition.right, doc);
  var operator = condition.operator;

  switch (operator) {
    case '===':
      return left === right;
    case '==':
      /*jshint eqeqeq:false*/
      return left == right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '>':
      return left > right;
    case '!=':
      /*jshint eqeqeq:false*/
      return left != right;
    case '!==':
      return left !== right;
  }
  throw new Error('unknown operator: ' + operator);
}

function evalCondition(condition, doc) {
  if (typeof condition === 'undefined') {
    return true;
  }
  if (condition.type === 'expression') {
    return evalExpressionCondition(condition, doc);
  }
  var result;
  var conditionVal;
  var shouldCoerce;
  var coerceTo;
  if (condition.value.type === 'coerce') {
    shouldCoerce = true;
    coerceTo = condition.value.boolean;
    conditionVal = condition.value.value;
  } else {
    conditionVal = condition.value;
  }

  result = evalValue(conditionVal, doc);

  if (shouldCoerce) {
    result = coerceTo ? !!result : !result;
  }

  return result;
}

function parse(fun) {

  var groups = fun.match(coreRegex);

  if (!groups) {
    return {error: true};
  }

  var docName = groups[1];
  var condition = parseCondition(groups[2], docName);
  var key = parseElement(groups[3], docName);
  var value = parseElement(groups[4], docName);

  return {
    condition: condition,
    key: key,
    value: value
  };
}

function evalValue(val, doc) {
  if (!val) {
    return undefined;
  }
  if (val.type === 'constant') {
    return val.value;
  } else if (val.type === 'wholeDoc') {
    return doc;
  } else if (val.type === 'joinedVal') {
    return {_id: evalValue(val.value, doc)};
  } else { // field
    return doc[val.field];
  }
}

function noeval(fun, emit) {

  var mapFun = parse(fun);

  return function (doc) {

    if (mapFun.error) {
      // user error for whatever reason
      // just bail out and emit nothing
      return;
    }

    var checkCondition = evalCondition(mapFun.condition, doc);

    if (checkCondition) {
      var key = evalValue(mapFun.key, doc);
      var value = evalValue(mapFun.value, doc);
      emit(key, value);
    }
  };
}

module.exports = noeval;

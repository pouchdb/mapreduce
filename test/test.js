/*jshint expr:true */
/* global sum */
'use strict';

var Pouch = require('pouchdb');
var Mapreduce = require('../');
Pouch.plugin(Mapreduce);
var chai = require('chai');
var should = chai.should();
require("mocha-as-promised")();
chai.use(require("chai-as-promised"));
var Promise = require('bluebird');
var all = Promise.all;
var dbs;
if (process.browser) {
  dbs = 'testdb' + Math.random() +
    ',http://localhost:2021/testdb' + Math.round(Math.random() * 100000);
} else {
  dbs = process.env.TEST_DB;
}

dbs.split(',').forEach(function (db) {
  var dbType = /^http/.test(db) ? 'http' : 'local';
  var viewTypes = ['persisted', 'temp'];
  viewTypes.forEach(function (viewType) {
    describe(dbType + ' with ' + viewType + ' views:', function () {
      tests(db, dbType, viewType);
    });
  });
});

function setTimeoutPromise(time) {
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(true); }, time);
  });
}

function tests(dbName, dbType, viewType) {

  var createView;
  if (viewType === 'persisted') {
    createView = function (db, viewObj) {
      var storableViewObj = {
        map : viewObj.map.toString()
      };
      if (viewObj.reduce) {
        storableViewObj.reduce = viewObj.reduce.toString();
      }
      return new Promise(function (resolve, reject) {
        db.put({
          _id: '_design/theViewDoc',
          views: {
            'theView' : storableViewObj
          }
        }, function (err) {
          if (err) {
            reject(err);
          } else {
            resolve('theViewDoc/theView');
          }
        });
      });
    };
  } else {
    createView = function (db, viewObj) {
      return new Promise(function (resolve) {
        process.nextTick(function () {
          resolve(viewObj);
        });
      });
    };
  }

  beforeEach(function () {
    return new Pouch(dbName);
  });
  afterEach(function () {
    return new Pouch(dbName).then(function (db) {
      var opts = {startkey : '_design', endkey: '`', include_docs : true};
      return db.allDocs(opts).then(function (designDocs) {
        var docs = designDocs.rows.map(function (row) {
          row.doc._deleted = true;
          return row.doc;
        });
        return db.bulkDocs({docs : docs}).then(function () {
          return db.viewCleanup();
        }).then(function (res) {
          res.ok.should.equal(true);
          return Pouch.destroy(dbName);
        });
      }).catch(function () {
        return Pouch.destroy(dbName);
      });
    });
  });
  describe('views', function () {
    it("Test basic view", function () {
      this.timeout(10000);
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo, doc);
          }
        }).then(function (view) {
          return db.bulkDocs({docs: [
            {foo: 'bar'},
            { _id: 'volatile', foo: 'baz' }
          ]}).then(function () {
            return db.get('volatile');
          }).then(function (doc) {
            return db.remove(doc);
          }).then(function () {
            return db.query(view, {include_docs: true, reduce: false});
          }).then(function (res) {
            res.rows.should.have.length(1, 'Dont include deleted documents');
            res.total_rows.should.equal(1, 'Include total_rows property.');
            res.rows.forEach(function (x) {
              should.exist(x.id);
              should.exist(x.key);
              should.exist(x.value);
              should.exist(x.value._rev);
              should.exist(x.doc);
              should.exist(x.doc._rev);
            });
          });
        });
      });
    });
    if (dbType === 'local' && viewType === 'temp') {
      it("with a closure", function () {
        return new Pouch(dbName).then(function (db) {
          return db.bulkDocs({docs: [
            {foo: 'bar'},
            { _id: 'volatile', foo: 'baz' }
          ]}).then(function () {
            var queryFun = (function (test) {
              return function (doc, emit) {
                if (doc._id === test) {
                  emit(doc.foo);
                }
              };
            }('volatile'));
            return db.query(queryFun, {reduce: false});
          });
        }).should.become({
          total_rows: 1,
          offset: 0,
          rows: [
            {
              id: 'volatile',
              key: 'baz',
              value: null
            }
          ]
        });
      });
    }
    if (viewType === 'temp') {
      it("Test passing just a function", function () {
        return new Pouch(dbName).then(function (db) {
          return db.bulkDocs({docs: [
            {foo: 'bar'},
            { _id: 'volatile', foo: 'baz' }
          ]}).then(function () {
            return db.get('volatile');
          }).then(function (doc) {
            return db.remove(doc);
          }).then(function () {
            return db.query(function (doc) {
              emit(doc.foo, doc);
            }, {include_docs: true, reduce: false});
          }).then(function (res) {
            res.rows.should.have.length(1, 'Dont include deleted documents');
            res.rows.forEach(function (x) {
              should.exist(x.id);
              should.exist(x.key);
              should.exist(x.value);
              should.exist(x.value._rev);
              should.exist(x.doc);
              should.exist(x.doc._rev);
            });
          });
        });
      });
    }
    it("Test opts.startkey/opts.endkey", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.key, doc);
          }
        }).then(function (queryFun) {
          return db.bulkDocs({docs: [
            {key: 'key1'},
            {key: 'key2'},
            {key: 'key3'},
            {key: 'key4'},
            {key: 'key5'}
          ]}).then(function () {
            return db.query(queryFun, {reduce: false, startkey: 'key2'});
          }).then(function (res) {
            res.rows.should.have.length(4, 'Startkey is inclusive');
            return db.query(queryFun, {reduce: false, endkey: 'key3'});
          }).then(function (res) {
            res.rows.should.have.length(3, 'Endkey is inclusive');
            return db.query(queryFun, {
              reduce: false,
              startkey: 'key2',
              endkey: 'key3'
            });
          }).then(function (res) {
            res.rows.should.have.length(2, 'Startkey and endkey together');
            return db.query(queryFun, {
              reduce: false,
              startkey: 'key4',
              endkey: 'key4'
            });
          }).then(function (res) {
            res.rows.should.have.length(1, 'Startkey=endkey');
          });
        });
      });
    });
    it("Test opts.key", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.key, doc);
          }
        }).then(function (queryFun) {
          return db.bulkDocs({docs: [
            {key: 'key1'},
            {key: 'key2'},
            {key: 'key3'},
            {key: 'key3'}
          ]}).then(function () {
            return db.query(queryFun, {reduce: false, key: 'key2'});
          }).then(function (res) {
            res.rows.should.have.length(1, 'Doc with key');
            return db.query(queryFun, {reduce: false, key: 'key3'});
          }).then(function (res) {
            res.rows.should.have.length(2, 'Multiple docs with key');
          });
        });
      });
    });

    it("Test basic view collation", function () {

      var values = [];

      // special values sort before all other types
      values.push(null);
      values.push(false);
      values.push(true);

      // then numbers
      values.push(1);
      values.push(2);
      values.push(3.0);
      values.push(4);

      // then text, case sensitive
      // currently chrome uses ascii ordering and so wont handle capitals properly
      values.push("a");
      //values.push("A");
      values.push("aa");
      values.push("b");
      //values.push("B");
      values.push("ba");
      values.push("bb");

      // then arrays. compared element by element until different.
      // Longer arrays sort after their prefixes
      values.push(["a"]);
      values.push(["b"]);
      values.push(["b", "c"]);
      values.push(["b", "c", "a"]);
      values.push(["b", "d"]);
      values.push(["b", "d", "e"]);

      // then object, compares each key value in the list until different.
      // larger objects sort after their subset objects.
      values.push({a: 1});
      values.push({a: 2});
      values.push({b: 1});
      values.push({b: 2});
      values.push({b: 2, a: 1}); // Member order does matter for collation.
      // CouchDB preserves member order
      // but doesn't require that clients will.
      // (this test might fail if used with a js engine
      // that doesn't preserve order)
      values.push({b: 2, c: 2});
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          }
        }).then(function (queryFun) {

          var docs = values.map(function (x, i) {
            return {_id: (i).toString(), foo: x};
          });
          return db.bulkDocs({docs: docs}).then(function () {
            return db.query(queryFun, {reduce: false});
          }).then(function (res) {
            res.rows.forEach(function (x, i) {
              JSON.stringify(x.key).should.equal(JSON.stringify(values[i]), 'keys collate');
            });
            return db.query(queryFun, {descending: true, reduce: false});
          }).then(function (res) {
            res.rows.forEach(function (x, i) {
              JSON.stringify(x.key).should.equal(JSON.stringify(values[values.length - 1 - i]),
                'keys collate descending');
            });
          });
        });
      });
    });

    it("Test joins", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            if (doc.doc_id) {
              emit(doc._id, {_id: doc.doc_id});
            }
          }
        }).then(function (queryFun) {
          return db.bulkDocs({docs: [
            {_id: 'mydoc', foo: 'bar'},
            { doc_id: 'mydoc' }
          ]}).then(function () {
            return db.query(queryFun, {include_docs: true, reduce: false});
          }).then(function (res) {
            should.exist(res.rows[0].doc);
            return res.rows[0].doc._id;
          });
        }).should.become('mydoc', 'mydoc included');
      });
    });

    it("No reduce function", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function () {
            emit('key', 'val');
          }
        }).then(function (queryFun) {
          return db.post({foo: 'bar'}).then(function () {
            return db.query(queryFun);
          });
        });
      }).should.be.fulfilled;
    });

    it("Built in _sum reduce function", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.val, 1);
          },
          reduce: "_sum"
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { val: 'bar' },
              { val: 'bar' },
              { val: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, {reduce: true, group_level: 999});
          }).then(function (resp) {
            return resp.rows.map(function (row) {
              return row.value;
            });
          });
        });
      }).should.become([2, 1]);
    });

    it("Built in _count reduce function", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.val, doc.val);
          },
          reduce: "_count"
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { val: 'bar' },
              { val: 'bar' },
              { val: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, {reduce: true, group_level: 999});
          }).then(function (resp) {
            return resp.rows.map(function (row) {
              return row.value;
            });
          });
        });
      }).should.become([2, 1]);
    });

    it("Built in _stats reduce function", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: "function(doc){emit(doc.val, 1);}",
          reduce: "_stats"
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { val: 'bar' },
              { val: 'bar' },
              { val: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, {reduce: true, group_level: 999});
          }).then(function (res) {
            return res.rows[0].value;
          });
        });
      }).should.become({
        sum: 2,
        count: 2,
        min: 1,
        max: 1,
        sumsqr: 2
      });
    });

    it("Built in _stats reduce function should throw an error with a promise", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: "function(doc){emit(doc.val, 'lala');}",
          reduce: "_stats"
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { val: 'bar' },
              { val: 'bar' },
              { val: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, {reduce: true, group_level: 999});
          });
        });
      }).should.be.rejected;
    });

    if (viewType === 'temp') {
      it("No reduce function, passing just a function", function () {
        return new Pouch(dbName).then(function (db) {
          return db.post({foo: 'bar'}).then(function () {
            var queryFun = function () {
              emit('key', 'val');
            };
            return db.query(queryFun);
          });
        }).should.be.fulfilled;
      });
    }

    it('Views should include _conflicts', function () {
      var db2name = 'test2' + Math.random();
      var cleanup = function () {
        return Pouch.destroy(db2name);
      };
      var doc1 = {_id: '1', foo: 'bar'};
      var doc2 = {_id: '1', foo: 'baz'};
      return new Pouch(dbName).then(function (db) {
        return new Pouch(db2name).then(function (remote) {
          return createView(db, {
            map : function (doc) {
              emit(doc._id, !!doc._conflicts);
            }
          }).then(function (queryFun) {
            var replicate = Promise.promisify(db.replicate.from, db.replicate);
            return db.post(doc1).then(function () {
              return remote.post(doc2);
            }).then(function () {
              return replicate(remote);
            }).then(function () {
              return db.get(doc1._id, {conflicts: true});
            }).then(function (res) {
              res._conflicts.should.exist;
              return db.query(queryFun);
            }).then(function (res) {
              res.rows[0].value.should.be.true;
            });
          }).finally(cleanup);
        });
      });
    });

    it("Test view querying with limit option", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            if (doc.foo === 'bar') {
              emit(doc.foo);
            }
          }
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' },
              { foo: 'bar' },
              { foo: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, { limit: 1 });
          }).then(function (res) {
            res.total_rows.should.equal(2, 'Correctly returns total rows');
            res.rows.should.have.length(1, 'Correctly limits returned rows');
          });
        });
      });
    });

    it("Test view querying with group_level option and reduce", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          },
          reduce: '_count'
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: ['foo', 'bar'] },
              { foo: ['foo', 'bar'] },
              { foo: ['foo', 'bar', 'baz'] },
              { foo: ['baz'] },
              { foo: ['baz', 'bar'] }
            ]
          }).then(function () {
            return db.query(queryFun, { group_level: 1, reduce: true});
          }).then(function (res) {
            res.rows.should.have.length(2, 'Correctly group returned rows');
            res.rows[0].key.should.deep.equal(['baz']);
            res.rows[0].value.should.equal(2);
            res.rows[1].key.should.deep.equal(['foo']);
            res.rows[1].value.should.equal(3);
            return db.query(queryFun, { group_level: 999, reduce: true});
          }).then(function (res) {
            res.rows.should.have.length(4, 'Correctly group returned rows');
            res.rows[2].key.should.deep.equal(['foo', 'bar']);
            res.rows[2].value.should.equal(2);
            return db.query(queryFun, { group_level: 0, reduce: true});
          }).then(function (res) {
            res.rows.should.have.length(1, 'Correctly group returned rows');
            res.rows[0].value.should.equal(5);
          });
        });
      });
    });

    it("Test view querying with invalid group_level options", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          },
          reduce: '_count'
        }).then(function (queryFun) {
          return db.query(queryFun, { group_level: -1, reduce: true
          }).then(function (res) {
            res.should.not.exist('expected error on invalid group_level');
          }).catch(function (err) {
            err.status.should.equal(400);
            err.name.should.equal('query_parse_error');
            err.message.should.be.a('string');
            return db.query(queryFun, { group_level: 'exact', reduce: true});
          }).then(function (res) {
            res.should.not.exist('expected error on invalid group_level');
          }).catch(function (err) {
            err.status.should.equal(400);
            err.name.should.equal('query_parse_error');
            err.message.should.be.a('string');
          });
        });
      });
    });

    it("Test view querying with limit option and reduce", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          },
          reduce: '_count'
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' },
              { foo: 'bar' },
              { foo: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, { limit: 1, group: true, reduce: true});
          }).then(function (res) {
            res.rows.should.have.length(1, 'Correctly limits returned rows');
            res.rows[0].key.should.equal('bar');
            res.rows[0].value.should.equal(2);
          });
        });
      });
    });

    it("Test view querying with a skip option and reduce", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          },
          reduce: '_count'
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' },
              { foo: 'bar' },
              { foo: 'baz' }
            ]
          }).then(function () {
            return db.query(queryFun, {skip: 1, group: true, reduce: true});
          });
        }).then(function (res) {
          res.rows.should.have.length(1, 'Correctly limits returned rows');
          res.rows[0].key.should.equal('baz');
          res.rows[0].value.should.equal(1);
        });
      });
    });

    if (viewType === 'persisted') {
      it("Query non existing view returns error", function () {
        return new Pouch(dbName).then(function (db) {
          var doc = {
            _id: '_design/barbar',
            views: {
              scores: {
                map: 'function(doc) { if (doc.score) { emit(null, doc.score); } }'
              }
            }
          };
          return db.post(doc).then(function () {
            return db.query('barbar/dontExist', {key: 'bar'});
          });
        }).should.be.rejected;
      });
    }

    it("Special document member _doc_id_rev should never leak outside", function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            if (doc.foo === 'bar') {
              emit(doc.foo);
            }
          }
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' }
            ]
          }).then(function () {
            return db.query(queryFun, { include_docs: true });
          }).then(function (res) {
            should.not.exist(res.rows[0].doc._doc_id_rev, '_doc_id_rev is leaking but should not');
          });
        });
      });
    });

    it('xxx - multiple view creations and cleanups', function () {
      this.timeout(10000);
      return new Pouch(dbName).then(function (db) {
        var map = function (doc) {
          emit(doc.num);
        };
        function createView(name) {
          var storableViewObj = {
            map: map.toString()
          };
          return  db.put({
            _id: '_design/' + name,
            views: {
              theView: storableViewObj
            }
          });
        }
        return db.bulkDocs({
          docs: [
            {_id: 'test1'}
          ]
        }).then(function () {
          function sequence(name) {
            return createView(name).then(function () {
              return db.query(name + '/theView').then(function () {
                return db.viewCleanup();
              });
            });
          }
          var attempts = [];
          var numAttempts = 10;
          for (var i = 0; i < numAttempts; i++) {
            attempts.push(sequence('test' + i));
          }
          return all(attempts).then(function () {
            var keys = [];
            for (var i = 0; i < numAttempts; i++) {
              keys.push('_design/test' + i);
            }
            return db.allDocs({keys : keys, include_docs : true});
          }).then(function (res) {
            var docs = res.rows.map(function (row) {
              row.doc._deleted = true;
              return row.doc;
            });
            return db.bulkDocs({docs : docs});
          }).then(function () {
            return db.viewCleanup();
          }).then(function (res) {
            res.ok.should.equal(true);
          });
        });
      });
    });

    it('If reduce function returns 0, resulting value should not be null', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.foo);
          },
          reduce: function () {
            return 0;
          }
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' }
            ]
          }).then(function () {
            return db.query(queryFun).then(function (data) {
              should.exist(data.rows[0].value);
            });
          });
        });
      });
    });

    it('Testing skip with a view', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.foo);
          }
        }).then(function (queryFun) {
          return db.bulkDocs({
            docs: [
              { foo: 'bar' },
              { foo: 'baz' },
              { foo: 'baf' }
            ]
          }).then(function () {
            return db.query(queryFun, {skip: 1});
          }).then(function (data) {
            data.rows.should.have.length(2);
            data.offset.should.equal(1);
            data.total_rows.should.equal(3);
          });
        });
      });
    });

    it('Map documents on 0/null/undefined/empty string', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.num);
          }
        }).then(function (mapFunction) {
          var docs = [
            {_id: '0', num: 0},
            {_id: '1', num: 1},
            {_id: 'undef' /* num is undefined */},
            {_id: 'null', num: null},
            {_id: 'empty', num: ''},
            {_id: 'nan', num: NaN},
            {_id: 'inf', num: Infinity},
            {_id: 'neginf', num: -Infinity}
          ];
          return db.bulkDocs({docs: docs}).then(function () {
            return db.query(mapFunction, {key: 0});
          }).then(function (data) {
            data.rows.should.have.length(1);
            data.rows[0].id.should.equal('0');

            return db.query(mapFunction, {key: ''});
          }).then(function (data) {
            data.rows.should.have.length(1);
            data.rows[0].id.should.equal('empty');

            return db.query(mapFunction, {key: undefined});
          }).then(function (data) {
            data.rows.should.have.length(8); // everything

            // keys that should all resolve to null
            var emptyKeys = [null, NaN, Infinity, -Infinity];
            return all(emptyKeys.map(function (emptyKey) {
              return db.query(mapFunction, {key: emptyKey}).then(function (data) {
                data.rows.map(function (row) {
                  return row.id;
                }).should.deep.equal(['inf', 'nan', 'neginf', 'null', 'undef']);
              });
            }));
          });
        });
      });
    });

    it('Testing query with keys', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            emit(doc.field);
          }
        }).then(function (queryFun) {
          var opts = {include_docs: true};
          return db.bulkDocs({
            docs: [
              {_id: 'doc_0', field: 0},
              {_id: 'doc_1', field: 1},
              {_id: 'doc_2', field: 2},
              {_id: 'doc_empty', field: ''},
              {_id: 'doc_null', field: null},
              {_id: 'doc_undefined' /* field undefined */},
              {_id: 'doc_foo', field: 'foo'}
            ]
          }).then(function () {
            return db.query(queryFun, opts);
          }).then(function (data) {
            data.rows.should.have.length(7, 'returns all docs');
            opts.keys = [];
            return db.query(queryFun, opts);
          }).then(function (data) {
            data.rows.should.have.length(0, 'returns 0 docs');

            opts.keys = [0];
            return db.query(queryFun, opts);
          }).then(function (data) {
            data.rows.should.have.length(1, 'returns one doc');
            data.rows[0].doc._id.should.equal('doc_0');

            opts.keys = [2, 'foo', 1, 0, null, ''];
            return db.query(queryFun, opts);
          }).then(function (data) {
            // check that the returned ordering fits opts.keys
            data.rows.should.have.length(7, 'returns 7 docs in correct order');
            data.rows[0].doc._id.should.equal('doc_2');
            data.rows[1].doc._id.should.equal('doc_foo');
            data.rows[2].doc._id.should.equal('doc_1');
            data.rows[3].doc._id.should.equal('doc_0');
            data.rows[4].doc._id.should.equal('doc_null');
            data.rows[5].doc._id.should.equal('doc_undefined');
            data.rows[6].doc._id.should.equal('doc_empty');

            opts.keys = [3, 1, 4, 2];
            return db.query(queryFun, opts);
          }).then(function (data) {
            // nonexistent keys just give us holes in the list
            data.rows.should.have.length(2, 'returns 2 non-empty docs');
            data.rows[0].key.should.equal(1);
            data.rows[0].doc._id.should.equal('doc_1');
            data.rows[1].key.should.equal(2);
            data.rows[1].doc._id.should.equal('doc_2');

            opts.keys = [2, 1, 2, 0, 2, 1];
            return db.query(queryFun, opts);
          }).then(function (data) {
            // with duplicates, we return multiple docs
            data.rows.should.have.length(6, 'returns 6 docs with duplicates');
            data.rows[0].doc._id.should.equal('doc_2');
            data.rows[1].doc._id.should.equal('doc_1');
            data.rows[2].doc._id.should.equal('doc_2');
            data.rows[3].doc._id.should.equal('doc_0');
            data.rows[4].doc._id.should.equal('doc_2');
            data.rows[5].doc._id.should.equal('doc_1');

            opts.keys = [2, 1, 2, 3, 2];
            return db.query(queryFun, opts);
          }).then(function (data) {
            // duplicates and unknowns at the same time, for maximum crazy
            data.rows.should.have.length(4, 'returns 2 docs with duplicates/unknowns');
            data.rows[0].doc._id.should.equal('doc_2');
            data.rows[1].doc._id.should.equal('doc_1');
            data.rows[2].doc._id.should.equal('doc_2');
            data.rows[3].doc._id.should.equal('doc_2');

            opts.keys = [3];
            return db.query(queryFun, opts);
          }).then(function (data) {
            data.rows.should.have.length(0, 'returns 0 doc due to unknown key');

            opts.include_docs = false;
            opts.keys = [3, 2];
            return db.query(queryFun, opts);
          }).then(function (data) {
            data.rows.should.have.length(1, 'returns 1 doc due to unknown key');
            data.rows[0].id.should.equal('doc_2');
            should.not.exist(data.rows[0].doc, 'no doc, since include_docs=false');
          });
        });
      });
    });

    it('Testing query with multiple keys, multiple docs', function () {
      function ids(row) {
        return row.id;
      }
      var opts = {keys: [0, 1, 2]};
      var spec;
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.field1);
            emit(doc.field2);
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: '0', field1: 0},
              {_id: '1a', field1: 1},
              {_id: '1b', field1: 1},
              {_id: '1c', field1: 1},
              {_id: '2+3', field1: 2, field2: 3},
              {_id: '4+5', field1: 4, field2: 5},
              {_id: '3+5', field1: 3, field2: 5},
              {_id: '3+4', field1: 3, field2: 4}
            ]
          }).then(function () {
            spec = ['0', '1a', '1b', '1c', '2+3'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts.keys = [3, 5, 4, 3];
            spec = ['2+3', '3+4', '3+5', '3+5', '4+5', '3+4', '4+5', '2+3', '3+4', '3+5'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);
          });
        });
      });
    });
    it('Testing multiple emissions (issue #14)', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.foo);
            emit(doc.foo);
            emit(doc.bar);
            emit(doc.bar, 'multiple values!');
            emit(doc.bar, 'crazy!');
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: 'doc1', foo : 'foo', bar : 'bar'},
              {_id: 'doc2', foo : 'foo', bar : 'bar'}
            ]
          }).then(function () {
            var opts = {keys: ['foo', 'bar']};

            return db.query(mapFunction, opts);
          });
        }).then(function (data) {
          data.rows.should.have.length(10);

          data.rows[0].key.should.equal('foo');
          data.rows[0].id.should.equal('doc1');
          data.rows[1].key.should.equal('foo');
          data.rows[1].id.should.equal('doc1');

          data.rows[2].key.should.equal('foo');
          data.rows[2].id.should.equal('doc2');
          data.rows[3].key.should.equal('foo');
          data.rows[3].id.should.equal('doc2');

          data.rows[4].key.should.equal('bar');
          data.rows[4].id.should.equal('doc1');
          should.not.exist(data.rows[4].value);
          data.rows[5].key.should.equal('bar');
          data.rows[5].id.should.equal('doc1');
          data.rows[5].value.should.equal('crazy!');
          data.rows[6].key.should.equal('bar');
          data.rows[6].id.should.equal('doc1');
          data.rows[6].value.should.equal('multiple values!');

          data.rows[7].key.should.equal('bar');
          data.rows[7].id.should.equal('doc2');
          should.not.exist(data.rows[7].value);
          data.rows[8].key.should.equal('bar');
          data.rows[8].id.should.equal('doc2');
          data.rows[8].value.should.equal('crazy!');
          data.rows[9].key.should.equal('bar');
          data.rows[9].id.should.equal('doc2');
          data.rows[9].value.should.equal('multiple values!');
        });
      });
    });
    it('Testing empty startkeys and endkeys', function () {
      var opts = {startkey: null, endkey: ''};
      function ids(row) {
        return row.id;
      }
      var spec;
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.field);
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: 'doc_empty', field: ''},
              {_id: 'doc_null', field: null},
              {_id: 'doc_undefined' /* field undefined */},
              {_id: 'doc_foo', field: 'foo'}
            ]
          }).then(function () {
            spec = ['doc_null', 'doc_undefined', 'doc_empty'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts = {startkey: '', endkey: 'foo'};
            spec = ['doc_empty', 'doc_foo'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts = {startkey: null, endkey: null};
            spec = ['doc_null', 'doc_undefined'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts.descending = true;
            spec.reverse();
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);
          });
        });
      });
    });

    it('Testing ordering with startkey/endkey/key', function () {
      var opts = {startkey: '1', endkey: '4'};
      function ids(row) {
        return row.id;
      }
      var spec;
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.field, null);
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: 'h', field: '4'},
              {_id: 'a', field: '1'},
              {_id: 'e', field: '2'},
              {_id: 'c', field: '1'},
              {_id: 'f', field: '3'},
              {_id: 'g', field: '4'},
              {_id: 'd', field: '2'},
              {_id: 'b', field: '1'}
            ]
          }).then(function () {
            spec = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts = {key: '1'};
            spec = ['a', 'b', 'c'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts = {key: '2'};
            spec = ['d', 'e'];
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec);

            opts.descending = true;
            spec.reverse();
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(spec, 'reverse order');
          });
        });
      });
    });

    it('opts.keys should work with complex keys', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.foo, doc.foo);
          }
        }).then(function (mapFunction) {
          var keys = [
            {key: 'missing'},
            ['test', 1],
            {key1: 'value1'},
            ['missing'],
            [0, 0]
          ];
          return db.bulkDocs({
            docs: [
              {foo: {key2: 'value2'}},
              {foo: {key1: 'value1'}},
              {foo: [0, 0]},
              {foo: ['test', 1]},
              {foo: [0, false]}
            ]
          }).then(function () {
            var opts = {keys: keys};
            return db.query(mapFunction, opts);
          }).then(function (data) {
            data.rows.should.have.length(3);
            data.rows[0].value.should.deep.equal(keys[1]);
            data.rows[1].value.should.deep.equal(keys[2]);
            data.rows[2].value.should.deep.equal(keys[4]);
          });
        });
      });
    });

    it('Testing ordering with dates', function () {
      function ids(row) {
        return row.id;
      }
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.date, null);
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: '1969', date: '1969 was when Space Oddity hit'},
              {_id: '1971', date : new Date('1971-12-17T00:00:00.000Z')}, // Hunky Dory was released
              {_id: '1972', date: '1972 was when Ziggy landed on Earth'},
              {_id: '1977', date: new Date('1977-01-14T00:00:00.000Z')}, // Low was released
              {_id: '1985', date: '1985+ is better left unmentioned'}
            ]
          }).then(function () {
            return db.query(mapFunction);
          }).then(function (data) {
            data.rows.map(ids).should.deep.equal(['1969', '1971', '1972', '1977', '1985']);
          });
        });
      });
    });

    if (viewType === 'persisted') {
      it('should error with a callback', function (done) {
        new Pouch(dbName, function (err, db) {
          db.query('fake/thing', function (err) {
            should.exist(err);
            done();
          });
        });
      });
    }

    it('should work with a joined doc', function () {
      function change(row) {
        return [row.key, row.doc._id, row.doc.val];
      }
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map: function (doc) {
            if (doc.join) {
              emit(doc.color, {_id : doc.join});
            }
          }
        }).then(function (mapFunction) {
          return db.bulkDocs({
            docs: [
              {_id: 'a', join: 'b', color: 'green'},
              {_id: 'b', val: 'c'},
              {_id: 'd', join: 'f', color: 'red'}
            ]
          }).then(function () {
            return db.query(mapFunction, {include_docs: true});
          }).then(function (resp) {
            return change(resp.rows[0]).should.deep.equal(['green', 'b', 'c']);
          });
        });
      });
    });

    it('should query correctly with a variety of criteria', function () {
      this.timeout(10000);
      return new Pouch(dbName).then(function (db) {

        return createView(db, {
          map : function (doc) {
            emit(doc._id);
          }
        }).then(function (mapFun) {

          var docs = [
            {_id : '0'},
            {_id : '1'},
            {_id : '2'},
            {_id : '3'},
            {_id : '4'},
            {_id : '5'},
            {_id : '6'},
            {_id : '7'},
            {_id : '8'},
            {_id : '9'}
          ];
          return db.bulkDocs({docs : docs}).then(function (res) {
            docs[3]._deleted = true;
            docs[7]._deleted = true;
            docs[3]._rev = res[3].rev;
            docs[7]._rev = res[7].rev;
            return db.remove(docs[3]);
          }).then(function () {
            return db.remove(docs[7]);
          }).then(function () {
            return db.query(mapFun, {});
          }).then(function (res) {
            res.rows.should.have.length(8, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5'});
          }).then(function (res) {
            res.rows.should.have.length(4, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5', skip : 2, limit : 10});
          }).then(function (res) {
            res.rows.should.have.length(2, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5', descending : true, skip : 1});
          }).then(function (res) {
            res.rows.should.have.length(4, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5', endkey : 'z'});
          }).then(function (res) {
            res.rows.should.have.length(4, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5', endkey : '5'});
          }).then(function (res) {
            res.rows.should.have.length(1, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '5', endkey : '4', descending : true});
          }).then(function (res) {
            res.rows.should.have.length(2, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '3', endkey : '7', descending : false});
          }).then(function (res) {
            res.rows.should.have.length(3, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '7', endkey : '3', descending : true});
          }).then(function (res) {
            res.rows.should.have.length(3, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {startkey : '', endkey : '0'});
          }).then(function (res) {
            res.rows.should.have.length(1, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {keys : ['0', '1', '3']});
          }).then(function (res) {
            res.rows.should.have.length(2, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {keys : ['0', '1', '0', '2', '1', '1']});
          }).then(function (res) {
            res.rows.should.have.length(6, 'correctly return rows');
            res.rows.map(function (row) { return row.key; }).should.deep.equal(
              ['0', '1', '0', '2', '1', '1']);
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {keys : []});
          }).then(function (res) {
            res.rows.should.have.length(0, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {keys : ['7']});
          }).then(function (res) {
            res.rows.should.have.length(0, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {key : '3'});
          }).then(function (res) {
            res.rows.should.have.length(0, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {key : '2'});
          }).then(function (res) {
            res.rows.should.have.length(1, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');
            return db.query(mapFun, {key : 'z'});
          }).then(function (res) {
            res.rows.should.have.length(0, 'correctly return rows');
            res.total_rows.should.equal(8, 'correctly return total_rows');

            return db.query(mapFun, {startkey : '5', endkey : '4'}).then(function (res) {
              res.should.not.exist('expected error on reversed start/endkey');
            }).catch(function (err) {
              err.status.should.equal(400);
              err.name.should.equal('query_parse_error');
              err.message.should.be.a('string');
            });
          });
        });
      });
    });

    it('should query correctly with skip/limit and multiple keys/values', function () {
      this.timeout(20000);
      var db = new Pouch(dbName);
      var docs = {
        docs: [
          {_id: 'doc1', foo : 'foo', bar : 'bar'},
          {_id: 'doc2', foo : 'foo', bar : 'bar'}
        ]
      };
      var getValues = function (res) {
        return res.value;
      };
      var getIds = function (res) {
        return res.id;
      };

      return createView(db, {
        map : function (doc) {
          emit(doc.foo, 'fooValue');
          emit(doc.foo);
          emit(doc.bar);
          emit(doc.bar, 'crazy!');
          emit(doc.bar, 'multiple values!');
          emit(doc.bar, 'crazy!');
        }
      }).then(function (mapFun) {

        return db.bulkDocs(docs).then(function () {
          return db.query(mapFun, {});
        }).then(function (res) {
          res.rows.should.have.length(12, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          res.rows.map(getValues).should.deep.equal(
            [null, 'crazy!', 'crazy!', 'multiple values!',
              null, 'crazy!', 'crazy!', 'multiple values!',
              null, 'fooValue', null, 'fooValue']);
          res.rows.map(getIds).should.deep.equal(
            ['doc1', 'doc1', 'doc1', 'doc1',
              'doc2', 'doc2', 'doc2', 'doc2',
              'doc1', 'doc1', 'doc2', 'doc2']);
          return db.query(mapFun, {startkey : 'foo'});
        }).then(function (res) {
          res.rows.should.have.length(4, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          res.rows.map(getValues).should.deep.equal(
            [null, 'fooValue', null, 'fooValue']);
          res.rows.map(getIds).should.deep.equal(
            ['doc1', 'doc1', 'doc2', 'doc2']);
          return db.query(mapFun, {startkey : 'foo', endkey : 'foo'});
        }).then(function (res) {
          res.rows.should.have.length(4, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'bar', endkey : 'bar'});
        }).then(function (res) {
          res.rows.should.have.length(8, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'foo', limit : 1});
        }).then(function (res) {
          res.rows.should.have.length(1, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          res.rows.map(getValues).should.deep.equal([null]);
          res.rows.map(getIds).should.deep.equal(['doc1']);
          return db.query(mapFun, {startkey : 'foo', limit : 2});
        }).then(function (res) {
          res.rows.should.have.length(2, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'foo', limit : 1000});
        }).then(function (res) {
          res.rows.should.have.length(4, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'foo', skip : 1});
        }).then(function (res) {
          res.rows.should.have.length(3, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'foo', skip : 3, limit : 0});
        }).then(function (res) {
          res.rows.should.have.length(0, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'foo', skip : 3, limit : 1});
        }).then(function (res) {
          res.rows.should.have.length(1, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          res.rows.map(getValues).should.deep.equal(['fooValue']);
          res.rows.map(getIds).should.deep.equal(['doc2']);
          return db.query(mapFun, {startkey : 'quux', skip : 3, limit : 1});
        }).then(function (res) {
          res.rows.should.have.length(0, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
          return db.query(mapFun, {startkey : 'bar', limit : 2});
        }).then(function (res) {
          res.rows.should.have.length(2, 'correctly return rows');
          res.total_rows.should.equal(12, 'correctly return total_rows');
        });
      });
    });

    it('should query correctly with undefined key/values', function () {
      var db = new Pouch(dbName);
      var docs = {
        docs: [
          {_id: 'doc1'},
          {_id: 'doc2'}
        ]
      };
      return createView(db, {
        map : function () {
          emit();
        }
      }).then(function (mapFun) {
        return db.bulkDocs(docs).then(function () {
          return db.query(mapFun, {});
        }).then(function (res) {
          res.total_rows.should.equal(2, 'correctly return total_rows');
          res.rows.should.deep.equal([
            {
              key : null,
              value : null,
              id : 'doc1'
            },
            {
              key : null,
              value : null,
              id : 'doc2'
            }
          ]);
        });
      });
    });
    it('should query correctly with no docs', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function () {
            emit();
          }
        }).then(function (queryFun) {
          return db.query(queryFun).then(function (res) {
            res.total_rows.should.equal(0, 'total_rows');
            res.offset.should.equal(0);
            res.rows.should.deep.equal([]);
          });
        });
      });
    });
    it('should query correctly with no emits', function () {
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function () {
          }
        }).then(function (queryFun) {
          return db.bulkDocs({docs : [
            {_id : 'foo'},
            {_id : 'bar'}
          ]}).then(function () {
            return db.query(queryFun).then(function (res) {
              res.total_rows.should.equal(0, 'total_rows');
              res.offset.should.equal(0);
              res.rows.should.deep.equal([]);
            });
          });
        });
      });
    });
    it('should correctly return results when reducing or not reducing', function () {
      function keyValues(row) {
        return { key: row.key, value: row.value };
      }
      function keys(row) {
        return row.key;
      }
      function values(row) {
        return row.value;
      }
      function docIds(row) {
        return row.doc._id;
      }
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.name);
          },
          reduce : '_count'
        }).then(function (queryFun) {
          return db.bulkDocs({docs : [
            {name : 'foo', _id : '1'},
            {name : 'bar', _id : '2'},
            {name : 'foo', _id : '3'},
            {name : 'quux', _id : '4'},
            {name : 'foo', _id : '5'},
            {name : 'foo', _id : '6'},
            {name : 'foo', _id : '7'}

          ]}).then(function () {
            return db.query(queryFun);
          }).then(function (res) {
            Object.keys(res.rows[0]).sort().should.deep.equal(['key', 'value'],
              'object only have 2 keys');
            should.not.exist(res.total_rows, 'no total_rows1');
            should.not.exist(res.offset, 'no offset1');
            res.rows.map(keyValues).should.deep.equal([
              {
                key   : null,
                value : 7
              }
            ]);
            return db.query(queryFun, {group : true});
          }).then(function (res) {
            Object.keys(res.rows[0]).sort().should.deep.equal(['key', 'value'],
              'object only have 2 keys');
            should.not.exist(res.total_rows, 'no total_rows2');
            should.not.exist(res.offset, 'no offset2');
            res.rows.map(keyValues).should.deep.equal([
              {
                key : 'bar',
                value : 1
              },
              {
                key : 'foo',
                value : 5
              },
              {
                key : 'quux',
                value : 1
              }
            ]);
            return db.query(queryFun, {reduce : false});
          }).then(function (res) {
            Object.keys(res.rows[0]).sort().should.deep.equal(['id', 'key', 'value'],
              'object only have 3 keys');
            res.total_rows.should.equal(7, 'total_rows1');
            res.offset.should.equal(0, 'offset1');
            res.rows.map(keys).should.deep.equal([
              'bar', 'foo', 'foo', 'foo', 'foo', 'foo', 'quux'
            ]);
            res.rows.map(values).should.deep.equal([
              null, null, null, null, null, null, null
            ]);
            return db.query(queryFun, {reduce : false, skip : 3});
          }).then(function (res) {
            Object.keys(res.rows[0]).sort().should.deep.equal(['id', 'key', 'value'],
              'object only have 3 keys');
            res.total_rows.should.equal(7, 'total_rows2');
            res.offset.should.equal(3, 'offset2');
            res.rows.map(keys).should.deep.equal([
              'foo', 'foo', 'foo', 'quux'
            ]);
            return db.query(queryFun, {reduce : false, include_docs : true});
          }).then(function (res) {
            Object.keys(res.rows[0]).sort().should.deep.equal(['doc', 'id', 'key', 'value'],
              'object only have 4 keys');
            res.total_rows.should.equal(7, 'total_rows3');
            res.offset.should.equal(0, 'offset3');
            res.rows.map(keys).should.deep.equal([
              'bar', 'foo', 'foo', 'foo', 'foo', 'foo', 'quux'
            ]);
            res.rows.map(values).should.deep.equal([
              null, null, null, null, null, null, null
            ]);
            res.rows.map(docIds).should.deep.equal([
              '2', '1', '3', '5', '6', '7', '4'
            ]);
            return db.query(queryFun, {include_docs : true}).then(function (res) {
              should.not.exist(res);
            }).catch(function (err) {
              err.status.should.equal(400);
              err.name.should.equal('query_parse_error');
              err.message.should.be.a('string');
              // include_docs is invalid for reduce
            });
          });
        });
      });
    });

    if (viewType === 'persisted') {
      it('should query correctly when stale', function () {
        return new Pouch(dbName).then(function (db) {
          return createView(db, {
            map : function (doc) {
              emit(doc.name);
            }
          }).then(function (queryFun) {
            return db.bulkDocs({docs : [
              {name : 'bar', _id : '1'},
              {name : 'foo', _id : '2'}
            ]}).then(function () {
              return db.query(queryFun, {stale : 'ok'});
            }).then(function (res) {
              res.total_rows.should.be.within(0, 2);
              res.offset.should.equal(0);
              res.rows.length.should.be.within(0, 2);
              return db.query(queryFun, {stale : 'update_after'});
            }).then(function (res) {
              res.total_rows.should.be.within(0, 2);
              res.rows.length.should.be.within(0, 2);
              return setTimeoutPromise(5);
            }).then(function () {
              return db.query(queryFun, {stale : 'ok'});
            }).then(function (res) {
              res.total_rows.should.equal(2);
              res.rows.length.should.equal(2);
              return db.get('2');
            }).then(function (doc2) {
              return db.remove(doc2);
            }).then(function () {
              return db.query(queryFun, {stale : 'ok', include_docs : true});
            }).then(function (res) {
              res.total_rows.should.be.within(1, 2);
              res.rows.length.should.be.within(1, 2);
              if (res.rows.length === 2) {
                res.rows[1].key.should.equal('foo');
                should.not.exist(res.rows[1].doc, 'should not throw if doc removed');
              }
              return db.query(queryFun);
            }).then(function (res) {
              res.total_rows.should.equal(1, 'equals1-1');
              res.rows.length.should.equal(1, 'equals1-2');
              return db.get('1');
            }).then(function (doc1) {
              doc1.name = 'baz';
              return db.post(doc1);
            }).then(function () {
              return db.query(queryFun, {stale : 'update_after'});
            }).then(function (res) {
              res.rows.length.should.equal(1);
              ['baz', 'bar'].indexOf(res.rows[0].key).should.be.above(-1,
                'key might be stale, thats ok');
              return setTimeoutPromise(5);
            }).then(function () {
              return db.query(queryFun, {stale : 'ok'});
            }).then(function (res) {
              res.rows.length.should.equal(1);
              res.rows[0].key.should.equal('baz');
            });
          });
        });
      });
    }

    it('should handle removes/undeletes/updates', function () {
      var theDoc = {name : 'bar', _id : '1'};

      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.name);
          }
        }).then(function (queryFun) {
          return db.put(theDoc).then(function (info) {
            theDoc._rev = info.rev;
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.length.should.equal(1);
            theDoc._deleted = true;
            return db.post(theDoc);
          }).then(function (info) {
            theDoc._rev = info.rev;
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.length.should.equal(0);
            theDoc._deleted = false;
            return db.post(theDoc);
          }).then(function (info) {
            theDoc._rev = info.rev;
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.length.should.equal(1);
            theDoc.name = 'foo';
            return db.post(theDoc);
          }).then(function (info) {
            theDoc._rev = info.rev;
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.length.should.equal(1);
            res.rows[0].key.should.equal('foo');
            theDoc._deleted = true;
            return db.post(theDoc);
          }).then(function (info) {
            theDoc._rev = info.rev;
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.length.should.equal(0);
          });
        });
      });
    });
    it('should handle user errors in map functions', function () {
      return new Pouch(dbName).then(function (db) {
        db.on('error', function () { /* noop */ });
        return createView(db, {
          map : function (doc) {
            emit(doc.nonexistent.foo);
          }
        }).then(function (queryFun) {
          return db.put({name : 'bar', _id : '1'}).then(function () {
            return db.query(queryFun);
          }).then(function (res) {
            res.rows.should.have.length(0);
          });
        });
      });
    });
    it('should handle user errors in reduce functions', function () {
      return new Pouch(dbName).then(function (db) {
        db.on('error', function () { /* noop */ });
        return createView(db, {
          map : function (doc) {
            emit(doc.name);
          },
          reduce : function (keys) {
            return keys[0].foo.bar;
          }
        }).then(function (queryFun) {
          return db.put({name : 'bar', _id : '1'}).then(function () {
            return db.query(queryFun, {group: true});
          }).then(function (res) {
            res.rows.map(function (row) {return row.key; }).should.deep.equal(['bar']);
            return db.query(queryFun, {reduce: false});
          }).then(function (res) {
            res.rows.map(function (row) {return row.key; }).should.deep.equal(['bar']);
          });
        });
      });
    });

    it('should properly query custom reduce functions', function () {
      this.timeout(5000);
      return new Pouch(dbName).then(function (db) {
        return createView(db, {
          map : function (doc) {
            emit(doc.name, doc.count);
          },
          reduce : function (keys, values, rereduce) {
            // calculate the average count per name
            if (!rereduce) {
              var result = {
                sum : sum(values),
                count : values.length
              };
              result.average = result.sum / result.count;
              return result;
            } else {
              var thisSum = sum(values.map(function (value) {return value.sum; }));
              var thisCount = sum(values.map(function (value) {return value.count; }));
              return {
                sum : thisSum,
                count : thisCount,
                average : (thisSum / thisCount)
              };
            }
          }
        }).then(function (queryFun) {
          return db.bulkDocs({docs : [
            {name : 'foo', count : 1},
            {name : 'bar', count : 7},
            {name : 'foo', count : 3},
            {name : 'quux', count : 3},
            {name : 'foo', count : 3},
            {name : 'foo', count : 0},
            {name : 'foo', count : 4},
            {name : 'baz', count : 3},
            {name : 'baz', count : 0},
            {name : 'baz', count : 2}
          ]}).then(function () {
            return db.query(queryFun, {group : true});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              },
              {
                key : 'baz',
                value : { sum: 5, count: 3, average: (5 / 3) }
              },
              {
                key : 'foo',
                value : { sum: 11, count: 5, average: (11 / 5) }
              },
              {
                key : 'quux',
                value : { sum: 3, count: 1, average: 3 }
              }
            ]}, 'all');
            return db.query(queryFun, {group : false});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : null,
                value : { sum: 26, count: 10, average: 2.6 }
              }
            ]}, 'group=false');
            return db.query(queryFun, {group : true, startkey : 'bar', endkey : 'baz', skip : 1});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'baz',
                value : { sum: 5, count: 3, average: (5 / 3) }
              }
            ]}, 'bar-baz skip 1');
            return db.query(queryFun, {group : true, endkey : 'baz'});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              },
              {
                key : 'baz',
                value : { sum: 5, count: 3, average: (5 / 3) }
              }
            ]}, '-baz');
            return db.query(queryFun, {group : true, startkey : 'foo'});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'foo',
                value : { sum: 11, count: 5, average: (11 / 5) }
              },
              {
                key : 'quux',
                value : { sum: 3, count: 1, average: 3 }
              }
            ]}, 'foo-');
            return db.query(queryFun, {group : true, startkey : 'foo', descending : true});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'foo',
                value : { sum: 11, count: 5, average: (11 / 5) }
              },
              {
                key : 'baz',
                value : { sum: 5, count: 3, average: (5 / 3) }
              },
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              }
            ]}, 'foo- descending=true');
            return db.query(queryFun, {group : true, startkey : 'quux', skip : 1});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'quux skip 1');
            return db.query(queryFun, {group : true, startkey : 'quux', limit : 0});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'quux limit 0');
            return db.query(queryFun, {group : true, startkey : 'bar', endkey : 'baz'});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              },
              {
                key : 'baz',
                value : { sum: 5, count: 3, average: (5 / 3) }
              }
            ]}, 'bar-baz');
            return db.query(queryFun, {group : true, keys : ['bar', 'baz'], limit : 1});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              }
            ]}, 'bar & baz');
            return db.query(queryFun, {group : true, keys : ['bar', 'baz'], limit : 0});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'bar & baz limit 0');
            return db.query(queryFun, {group : true, key : 'bar', limit : 0});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'key=bar limit 0');
            return db.query(queryFun, {group : true, key : 'bar'});
          }).then(function (res) {
            res.should.deep.equal({rows : [
              {
                key : 'bar',
                value : { sum: 7, count: 1, average : 7}
              }
            ]}, 'key=bar');
            return db.query(queryFun, {group : true, key : 'zork'});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'zork');
            return db.query(queryFun, {group : true, keys : []});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'keys=[]');
            return db.query(queryFun, {group : true, key : null});
          }).then(function (res) {
            res.should.deep.equal({rows : [
            ]}, 'key=null');
          });
        });
      });
    });

    if (viewType === 'persisted') {

      it('should handle user errors in design doc names', function () {
        return new Pouch(dbName).then(function (db) {
          return db.put({
            _id : '_design/theViewDoc'
          }).then(function () {
            return db.query('foo/bar');
          }).then(function (res) {
            should.not.exist(res);
          }).catch(function (err) {
            err.name.should.equal('not_found');
            return db.put(({_id : '_design/void', views : {1 : null}})).then(function () {
              return db.query('void/1');
            }).then(function (res) {
              should.not.exist(res);
            }).catch(function (err) {
              err.name.should.be.a('string');
              // this might throw due to erroneous ddoc, but that's ok
              return db.viewCleanup().catch(function (err) {
                err.name.should.equal('unknown_error');
              });
            });
          });
        });
      });

      it('should allow the user to create many design docs', function () {
        this.timeout(4000);
        function getKey(row) {
          return row.key;
        }
        return new Pouch(dbName).then(function (db) {
          return db.put({
            _id : '_design/foo',
            views : {
              byId : { map : function (doc) { emit(doc._id); }.toString()},
              byField : { map : function (doc) { emit(doc.field); }.toString()}
            }
          }).then(function () {
            return db.put({_id : 'myDoc', field : 'myField'});
          }).then(function () {
            return db.query('foo/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
            return db.put({
              _id : '_design/bar',
              views : {
                byId : {map : function (doc) { emit(doc._id); }.toString()}
              }
            });
          }).then(function () {
            return db.query('bar/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
          }).then(function () {
            return db.viewCleanup();
          }).then(function () {
            return db.query('foo/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
            return db.query('foo/byField');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myField']);
            return db.query('bar/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
            return db.get('_design/bar');
          }).then(function (barDoc) {
            return db.remove(barDoc);
          }).then(function () {
            return db.get('_design/foo');
          }).then(function (fooDoc) {
            delete fooDoc.views.byField;
            return db.put(fooDoc);
          }).then(function () {
            return db.query('foo/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
            return db.viewCleanup();
          }).then(function () {
            return db.query('foo/byId');
          }).then(function (res) {
            res.rows.map(getKey).should.deep.equal(['myDoc']);
            return db.query('foo/byField').then(function (res) {
              should.not.exist(res);
            }).catch(function (err) {
              err.name.should.equal('not_found');
              return db.query('bar/byId').then(function (res) {
                should.not.exist(res);
              }).catch(function (err) {
                err.name.should.equal('not_found');
                return db.get('_design/foo').then(function (fooDoc) {
                  return db.remove(fooDoc).then(function () {
                    return db.viewCleanup();
                  });
                });
              });
            });
          });
        });
      });
    }
  });
}

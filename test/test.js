'use strict';

var pouch = require('pouchdb');
var Mapreduce = require('../');
pouch.plugin('mapreduce', Mapreduce);
var should = require('chai').should();
describe('local', function () {
  process.argv.slice(3).forEach(tests);
});
function tests(dbName) {
  beforeEach(function (done) {
    pouch(dbName, function (err, d) {
      done();
    });
  });
  afterEach(function (done) {
    pouch.destroy(dbName, function () {
      done();
    });
  });
  describe('views', function () {
    it("Test basic view", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({docs: [
          {foo: 'bar'},
          { _id: 'volatile', foo: 'baz' }
        ]}, {}, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.foo, doc);
            }
          };
          db.get('volatile', function (_, doc) {
            db.remove(doc, function (_, resp) {
              db.query(queryFun, {include_docs: true, reduce: false}, function (_, res) {
                res.rows.should.have.length(1, 'Dont include deleted documents');
                res.total_rows.should.equal(1, 'Include total_rows property.');
                res.rows.forEach(function (x, i) {
                  should.exist(x.id);
                  should.exist(x.key);
                  should.exist(x.value);
                  should.exist(x.value._rev);
                  should.exist(x.doc);
                  should.exist(x.doc._rev);
                });
                done();
              });
            });
          });
        });
      });
    });

    it("Test passing just a function", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({docs: [
          {foo: 'bar'},
          { _id: 'volatile', foo: 'baz' }
        ]}, {}, function () {
          var queryFun = function (doc) {
            emit(doc.foo, doc);
          };
          db.get('volatile', function (_, doc) {
            db.remove(doc, function (_, resp) {
              db.query(queryFun, {include_docs: true, reduce: false}, function (_, res) {
                res.rows.should.have.length(1, 'Dont include deleted documents');
                res.rows.forEach(function (x, i) {
                  should.exist(x.id);
                  should.exist(x.key);
                  should.exist(x.value);
                  should.exist(x.value._rev);
                  should.exist(x.doc);
                  should.exist(x.doc._rev);
                });
                done();
              });
            });
          });
        });
      });
    });

    it("Test opts.startkey/opts.endkey", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({docs: [
          {key: 'key1'},
          {key: 'key2'},
          {key: 'key3'},
          {key: 'key4'},
          {key: 'key5'}
        ]}, {}, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.key, doc);
            }
          };
          db.query(queryFun, {reduce: false, startkey: 'key2'}, function (_, res) {
            res.rows.should.have.length(4, 'Startkey is inclusive');
            db.query(queryFun, {reduce: false, endkey: 'key3'}, function (_, res) {
              res.rows.should.have.length(3, 'Endkey is inclusive');
              db.query(queryFun, {reduce: false, startkey: 'key2', endkey: 'key3'}, function (_, res) {
                res.rows.should.have.length(2, 'Startkey and endkey together');
                db.query(queryFun, {reduce: false, startkey: 'key4', endkey: 'key4'}, function (_, res) {
                  res.rows.should.have.length(1, 'Startkey=endkey');
                  done();
                });
              });
            });
          });
        });
      });
    });

    it("Test opts.key", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({docs: [
          {key: 'key1'},
          {key: 'key2'},
          {key: 'key3'},
          {key: 'key3'}
        ]}, {}, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.key, doc);
            }
          };
          db.query(queryFun, {reduce: false, key: 'key2'}, function (_, res) {
            res.rows.should.have.length(1, 'Doc with key');
            db.query(queryFun, {reduce: false, key: 'key3'}, function (_, res) {
              res.rows.should.have.length(2, 'Multiple docs with key');
              done();
            });
          });
        });
      });
    });

    it("Test basic view collation", function (done) {

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

      pouch(dbName, function (err, db) {
        var docs = values.map(function (x, i) {
          return {_id: (i).toString(), foo: x};
        });
        db.bulkDocs({docs: docs}, {}, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.foo, null);
            }
          };
          db.query(queryFun, {reduce: false}, function (_, res) {
            res.rows.forEach(function (x, i) {
              JSON.stringify(x.key).should.equal(JSON.stringify(values[i]), 'keys collate');
            });
            db.query(queryFun, {descending: true, reduce: false}, function (_, res) {
              res.rows.forEach(function (x, i) {
                JSON.stringify(x.key).should.equal(JSON.stringify(values[values.length - 1 - i]),
                  'keys collate descending');
              });
              done();
            });
          });
        });
      });
    });

    it("Test joins", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({docs: [
          {_id: 'mydoc', foo: 'bar'},
          { doc_id: 'mydoc' }
        ]}, {}, function () {
          var queryFun = {
            map: function (doc) {
              if (doc.doc_id) {
                emit(doc._id, {_id: doc.doc_id});
              }
            }
          };
          db.query(queryFun, {include_docs: true, reduce: false}, function (_, res) {
            should.exist(res.rows[0].doc);
            res.rows[0].doc._id.should.equal('mydoc', 'mydoc included');
            done();
          });
        });
      });
    });

    it("No reduce function", function (done) {
      pouch(dbName, function (err, db) {
        db.post({foo: 'bar'}, function (err, res) {
          var queryFun = {
            map: function (doc) {
              emit('key', 'val');
            }
          };
          db.query(queryFun, function (err, res) {
            done();
          });
        });
      });
    });

    it("Built in _sum reduce function", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { val: 'bar' },
            { val: 'bar' },
            { val: 'baz' }
          ]
        }, null, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.val, 1);
            },
            reduce: "_sum"
          };
          db.query(queryFun, {reduce: true, group_level: 999}, function (err, res) {
            res.rows.should.have.length(2);
            res.rows[0].value.should.equal(2);
            res.rows[1].value.should.equal(1);
            done();
          });
        });
      });
    });

    it("Built in _count reduce function", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { val: 'bar' },
            { val: 'bar' },
            { val: 'baz' }
          ]
        }, null, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.val, doc.val);
            },
            reduce: "_count"
          };
          db.query(queryFun, {reduce: true, group_level: 999}, function (err, res) {
            res.rows.should.have.length(2);
            res.rows[0].value.should.equal(2);
            res.rows[1].value.should.equal(1);
            done();
          });
        });
      });
    });

    it("Built in _stats reduce function", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { val: 'bar' },
            { val: 'bar' },
            { val: 'baz' }
          ]
        }, null, function () {
          var queryFun = {
            map: function (doc) {
              emit(doc.val, 1);
            },
            reduce: "_stats"
          };
          db.query(queryFun, {reduce: true, group_level: 999}, function (err, res) {
            var stats = res.rows[0].value;
            stats.sum.should.equal(2);
            stats.count.should.equal(2);
            stats.min.should.equal(1);
            stats.max.should.equal(1);
            stats.sumsqr.should.equal(2);
            done();
          });
        });
      });
    });

    it("No reduce function, passing just a  function", function (done) {
      pouch(dbName, function (err, db) {
        db.post({foo: 'bar'}, function (err, res) {
          var queryFun = function (doc) {
            emit('key', 'val');
          };
          db.query(queryFun, function (err, res) {
            done();
          });
        });
      });
    });


    it('Views should include _conflicts', function (done) {
      var self = this;
      var doc1 = {_id: '1', foo: 'bar'};
      var doc2 = {_id: '1', foo: 'baz'};
      var queryFun = function (doc) {
        emit(doc._id, !!doc._conflicts);
      };
      pouch(dbName, function (err, db) {
        pouch('testdb2', function (err, remote) {
          db.post(doc1, function (err, res) {
            remote.post(doc2, function (err, res) {
              db.replicate.from(remote, function (err, res) {
                db.get(doc1._id, {conflicts: true}, function (err, res) {
                  should.exist(res._conflicts);
                  db.query(queryFun, function (err, res) {
                    should.exist(res.rows[0].value);
                    pouch.destroy('testdb2', function () {
                      done();
                    });
                  });
                });
              });
            });
          });
        });
      });
    });

    it("Test view querying with limit option", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { foo: 'bar' },
            { foo: 'bar' },
            { foo: 'baz' }
          ]
        }, null, function () {

          db.query(function (doc) {
            if (doc.foo === 'bar') {
              emit(doc.foo);
            }
          }, { limit: 1 }, function (err, res) {
            res.total_rows.should.equal(2, 'Correctly returns total rows');
            res.rows.should.have.length(1, 'Correctly limits returned rows');
            done();
          });

        });
      });
    });

    it("Query non existing view returns error", function (done) {
      pouch(dbName, function (err, db) {
        var doc = {
          _id: '_design/barbar',
          views: {
            scores: {
              map: 'function(doc) { if (doc.score) { emit(null, doc.score); } }'
            }
          }
        };
        db.post(doc, function (err, info) {
          db.query('barbar/dontExist', {key: 'bar'}, function (err, res) {
            err.name.should.equal('not_found');
            err.message.should.equal('missing_named_view');
            done();
          });
        });
      });
    });

    it("Special document member _doc_id_rev should never leak outside", function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { foo: 'bar' }
          ]
        }, null, function () {

          db.query(function (doc) {
            if (doc.foo === 'bar') {
              emit(doc.foo);
            }
          }, { include_docs: true }, function (err, res) {
            should.not.exist(res.rows[0].doc._doc_id_rev, '_doc_id_rev is leaking but should not');
            done();
          });
        });
      });
    });

    it('If reduce function returns 0, resulting value should not be null', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { foo: 'bar' }
          ]
        }, null, function () {
          db.query({
            map: function (doc) {
              emit(doc.foo);
            },
            reduce: function (key, values, rereduce) {
              return 0;
            }
          }, function (err, data) {
            should.exist(data.rows[0].value);
            done();
          });
        });
      });
    });

    it('Testing skip with a view', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            { foo: 'bar' },
            { foo: 'baz' },
            { foo: 'baf' }
          ]
        }, null, function () {
          db.query(function (doc) {
            emit(doc.foo, null);
          }, {skip: 1}, function (err, data) {
            should.not.exist(err, 'Error:' + JSON.stringify(err));
            data.rows.should.have.length(2);
            done();
          });
        });
      });
    });

    it('Map documents on 0/null/undefined/empty string', function (done) {
      pouch(dbName, function (err, db) {
        var docs = [
          {_id: 'doc0', num: 0},
          {_id: 'doc1', num: 1},
          {_id: 'doc2' /* num is undefined */},
          {_id: 'doc3', num: null},
          {_id: 'doc4', num: ''}
        ];
        db.bulkDocs({docs: docs}, function (err) {
          var mapFunction = function (doc) {
            emit(doc.num, null);
          };

          db.query(mapFunction, {key: 0, include_docs: true}, function (err, data) {
            data.rows.should.have.length(1);
            data.rows[0].doc._id.should.equal('doc0');

            db.query(mapFunction, {key: null, include_docs: true}, function (err, data) {
              data.rows.should.have.length(2);
              data.rows[0].doc._id.should.equal('doc2');
              data.rows[1].doc._id.should.equal('doc3');

              db.query(mapFunction, {key: '', include_docs: true}, function (err, data) {
                data.rows.should.have.length(1);
                data.rows[0].doc._id.should.equal('doc4');

                db.query(mapFunction, {key: undefined, include_docs: true}, function (err, data) {
                  data.rows.should.have.length(5); // everything
                  done();
                });
              });
            });
          });
        });
      });
    });

    it('Testing query with keys', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            {_id: 'doc_0', field: 0},
            {_id: 'doc_1', field: 1},
            {_id: 'doc_2', field: 2},
            {_id: 'doc_empty', field: ''},
            {_id: 'doc_null', field: null},
            {_id: 'doc_undefined' /* field undefined */},
            {_id: 'doc_foo', field: 'foo'}
          ]
        }, function (err) {
          var mapFunction = function (doc) {
            emit(doc.field, null);
          };
          var opts = {include_docs: true};
          db.query(mapFunction, opts, function (err, data) {
            data.rows.should.have.length(7, 'returns all docs');

            opts.keys = [];
            db.query(mapFunction, opts, function (err, data) {
              // no docs
              data.rows.should.have.length(0, 'returns 0 docs');

              opts.keys = [0];
              db.query(mapFunction, opts, function (err, data) {
                data.rows.should.have.length(1, 'returns one doc');
                data.rows[0].doc._id.should.equal('doc_0');

                opts.keys = [2, 'foo', 1, 0, null, ''];
                db.query(mapFunction, opts, function (err, data) {
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
                  db.query(mapFunction, opts, function (err, data) {
                    // nonexistent keys just give us holes in the list
                    data.rows.should.have.length(2, 'returns 2 non-empty docs');
                    data.rows[0].key.should.equal(1);
                    data.rows[0].doc._id.should.equal('doc_1');
                    data.rows[1].key.should.equal(2);
                    data.rows[1].doc._id.should.equal('doc_2');

                    opts.keys = [2, 1, 2, 0, 2, 1];
                    db.query(mapFunction, opts, function (err, data) {
                      // with duplicates, we return multiple docs
                      data.rows.should.have.length(6, 'returns 6 docs with duplicates');
                      data.rows[0].doc._id.should.equal('doc_2');
                      data.rows[1].doc._id.should.equal('doc_1');
                      data.rows[2].doc._id.should.equal('doc_2');
                      data.rows[3].doc._id.should.equal('doc_0');
                      data.rows[4].doc._id.should.equal('doc_2');
                      data.rows[5].doc._id.should.equal('doc_1');

                      opts.keys = [2, 1, 2, 3, 2];
                      db.query(mapFunction, opts, function (err, data) {
                        // duplicates and unknowns at the same time, for maximum crazy
                        data.rows.should.have.length(4, 'returns 2 docs with duplicates/unknowns');
                        data.rows[0].doc._id.should.equal('doc_2');
                        data.rows[1].doc._id.should.equal('doc_1');
                        data.rows[2].doc._id.should.equal('doc_2');
                        data.rows[3].doc._id.should.equal('doc_2');

                        opts.keys = [3];
                        db.query(mapFunction, opts, function (err, data) {
                          data.rows.should.have.length(0, 'returns 0 doc due to unknown key');

                          opts.include_docs = false;
                          opts.keys = [3, 2];
                          db.query(mapFunction, opts, function (err, data) {
                            data.rows.should.have.length(1, 'returns 1 doc due to unknown key');
                            data.rows[0].id.should.equal('doc_2');
                            should.not.exist(data.rows[0].doc, 'no doc, since include_docs=false');
                            done();
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });

    it('Testing query with multiple keys, multiple docs', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
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
        }, function (err) {
          var mapFunction = function (doc) {
            emit(doc.field1, null);
            emit(doc.field2, null);
          };
          var opts = {keys: [0, 1, 2]};

          db.query(mapFunction, opts, function (err, data) {
            data.rows.should.have.length(5);
            data.rows[0].id.should.equal('0');
            data.rows[1].id.should.equal('1a');
            data.rows[2].id.should.equal('1b');
            data.rows[3].id.should.equal('1c');
            data.rows[4].id.should.equal('2+3');

            opts.keys = [3, 5, 4, 3];

            db.query(mapFunction, opts, function (err, data) {
              // ordered by m/r key, then doc id
              data.rows.should.have.length(10);
              // 3
              data.rows[0].id.should.equal('2+3');
              data.rows[1].id.should.equal('3+4');
              data.rows[2].id.should.equal('3+5');
              // 5
              data.rows[3].id.should.equal('3+5');
              data.rows[4].id.should.equal('4+5');
              // 4
              data.rows[5].id.should.equal('3+4');
              data.rows[6].id.should.equal('4+5');
              // 3
              data.rows[7].id.should.equal('2+3');
              data.rows[8].id.should.equal('3+4');
              data.rows[9].id.should.equal('3+5');
              done();
            });
          });

        });
      });
    });
    it('Testing multiple emissions (issue #14)', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            {_id: 'doc1', foo : 'foo', bar : 'bar'},
            {_id: 'doc2', foo : 'foo', bar : 'bar'}
          ]
        }, function (err) {
          var mapFunction = function (doc) {
            emit(doc.foo, null);
            emit(doc.foo, null);
            emit(doc.bar, null);
            emit(doc.bar, 'multiple values!');
            emit(doc.bar, 'crazy!');
          };
          var opts = {keys: ['foo', 'bar']};

          db.query(mapFunction, opts, function (err, data) {
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

            done();
          });
        });
      });
    });

    it('Testing empty startkeys and endkeys', function (done) {
      pouch(dbName, function (err, db) {
        db.bulkDocs({
          docs: [
            {_id: 'doc_empty', field: ''},
            {_id: 'doc_null', field: null},
            {_id: 'doc_undefined' /* field undefined */},
            {_id: 'doc_foo', field: 'foo'}
          ]
        }, function (err) {
          var mapFunction = function (doc) {
            emit(doc.field, null);
          };
          var opts = {startkey: null, endkey: ''};
          db.query(mapFunction, opts, function (err, data) {
            data.rows.should.have.length(3);
            data.rows[0].id.should.equal('doc_null');
            data.rows[1].id.should.equal('doc_undefined');
            data.rows[2].id.should.equal('doc_empty');

            opts = {startkey: '', endkey: 'foo'};
            db.query(mapFunction, opts, function (err, data) {
              data.rows.should.have.length(2);
              data.rows[0].id.should.equal('doc_empty');
              data.rows[1].id.should.equal('doc_foo');

              opts = {startkey: null, endkey: null};
              db.query(mapFunction, opts, function (err, data) {
                data.rows.should.have.length(2);
                data.rows[0].id.should.equal('doc_null');
                data.rows[1].id.should.equal('doc_undefined');

                opts.descending = true;
                db.query(mapFunction, opts, function (err, data) {
                  data.rows.should.have.length(2);
                  data.rows[0].id.should.equal('doc_undefined');
                  data.rows[1].id.should.equal('doc_null');
                  done();
                });
              });
            });
          });
        });
      });

      it('Testing ordering with startkey/endkey/key', function (done) {
        pouch(dbName, function (err, db) {
          db.bulkDocs({
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
          }, function (err) {
            var mapFunction = function (doc) {
              emit(doc.field, null);
            };
            var opts = {startkey: '1', endkey: '4'};
            db.query(mapFunction, opts, function (err, data) {
              data.rows.should.have.length(8);
              // 1
              data.rows[0].id.should.equal('a');
              data.rows[1].id.should.equal('b');
              data.rows[2].id.should.equal('c');
              // 2
              data.rows[3].id.should.equal('d');
              data.rows[4].id.should.equal('e');
              // 3
              data.rows[5].id.should.equal('f');
              // 4
              data.rows[6].id.should.equal('g');
              data.rows[7].id.should.equal('h');

              opts = {key: '1'};
              db.query(mapFunction, opts, function (err, data) {
                data.rows.should.have.length(3);
                data.rows[0].id.should.equal('a');
                data.rows[1].id.should.equal('b');
                data.rows[2].id.should.equal('c');

                opts = {key: '2'};
                db.query(mapFunction, opts, function (err, data) {
                  data.rows.should.have.length(2);
                  data.rows[0].id.should.equal('d');
                  data.rows[1].id.should.equal('e');

                  opts.descending = true;
                  db.query(mapFunction, opts, function (err, data) {
                    data.rows.should.have.length(2);
                    data.rows[0].id.should.equal('e');
                    data.rows[1].id.should.equal('d');
                    done();
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}
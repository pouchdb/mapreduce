Abstract Map Reduce
=====

[![Build Status](https://travis-ci.org/nolanlawson/pouchdb-abstract-mapreduce.svg)](https://travis-ci.org/nolanlawson/pouchdb-abstract-mapreduce)

Abstract map/reduce functions pulled out of the PouchDB map/reduce plugin.  Designed to be used for:

* map/reduce
* geo queries
* full-text search queries
* pouchdb-indexes (aka Mango queries, aka Cloudant Query Language)

Building
----

    npm install
    npm run build

Testing
----

**Warning:** to really test your current working copy, you should link `pouchdb-mapreduce` to its parent module:

```bash
rm -fr node_modules/pouchdb-mapreduce/node_modules/pouchdb-abstract-mapreduce
ln -s ../../.. node_modules/pouchdb-mapreduce/node_modules/pouchdb-abstract-mapreduce
```

### In Node

    npm test

To run coverage tests:

    npm run coverage

To run individual tests:

    GREP=my_search_term npm test

### In the browser

Run 

    npm run dev
    
and then point your favorite browser to [http://127.0.0.1:8001/test/index.html](http://127.0.0.1:8001/test/index.html).

To run individual tests, load e.g.:

    http://127.0.0.1:8001/test/index.html?grep=my_search_term

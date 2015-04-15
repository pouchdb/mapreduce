#!/bin/bash
: ${TEST_DB:="./testdata/client/testdb,http://localhost:5984/testdb"}
export TEST_DB
mkdir -p ./testdata/client
mocha --reporter=spec --grep=$GREP test/test.js

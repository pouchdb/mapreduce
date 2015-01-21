#!/bin/bash
: ${TEST_DB:="testdb,http://localhost:5984/testdb"}
export TEST_DB
mocha --reporter=spec --grep=$GREP test/test.js

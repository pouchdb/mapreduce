#!/bin/bash

: ${CLIENT:="node"}

if [ "$SERVER" == "pouchdb-server" ]; then
    mkdir -p ./testdata/server
    if [ "$TRAVIS_REPO_SLUG" == "pouchdb/mapreduce" ]; then
      # pouchdb-server setup
      rm -rf node_modules/pouchdb-server/node_modules/pouchdb/node_modules/mapreduce
      ln -s ../../../../.. node_modules/pouchdb-server/node_modules/pouchdb/node_modules/mapreduce
    fi
    echo '{
        "httpd": {
            "port": 5985
        },
        "couchdb": {
            "database_dir": "./testdata/server"
        },
        "log": {
            "file": "./testdata/server/log.txt"
        }
    }' > ./testdata/server/config.json
    ./node_modules/.bin/pouchdb-server -c ./testdata/server/config.json &
    export POUCHDB_SERVER_PID=$!
    : ${TEST_DB:="./testdata/client/testdb,http://localhost:5985/testdb"}
    export TEST_DB
    sleep 5
fi

if [ "$CLIENT" == "node" ]; then
    npm run test-node
else
    npm run test-browser
fi

EXIT_STATUS=$?
if [[ ! -z $POUCHDB_SERVER_PID ]]; then
  kill $POUCHDB_SERVER_PID
fi
exit $EXIT_STATUS

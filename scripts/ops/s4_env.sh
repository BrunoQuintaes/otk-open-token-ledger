# Exports the connection settings of the isolated Postgres and Redis test services used by the
# test/services suites that name this file (test-only credentials, loopback addresses only).
# Variables set: OTK_TEST_PG_URL, OTK_TEST_REDIS_URL, OTK_TEST_PG_CONTAINER. It starts nothing.
# Usage: . scripts/ops/s4_env.sh   (source it in the shell that runs the tests; do not execute it)
# S4 (run 20260930-1625): isolated service endpoints for test/services (test-only credentials, loopback).
# PG port 55832 (55632 is inside a Windows excluded port range, S4-DEC-07).
export OTK_TEST_PG_URL=postgres://otk:otk-test-only@127.0.0.1:55832/otk
export OTK_TEST_REDIS_URL=redis://:otk-test-only@127.0.0.1:56579
export OTK_TEST_PG_CONTAINER=otk-d1d8-1625-s4-postgres-1

# Exports the connection settings of the isolated Postgres and Redis test services used by the
# test/services suites that name this file (test-only credentials, loopback addresses only).
# Variables set: OTK_TEST_PG_URL, OTK_TEST_REDIS_URL, OTK_TEST_PG_CONTAINER. It starts nothing;
# the compose command to start the services is in the comment below.
# Usage: . scripts/ops/fps5_env.sh   (source it in the shell that runs the tests; do not execute it)
# Fechamento pós-S5 (run 20260930-1625): isolated service endpoints for test/services (test-only
# credentials, loopback). Own compose project otk-d1d8-1625-fps5, subnet 172.31.230.0/24, ports outside
# the Windows excluded ranges (checked with `netsh interface ipv4 show excludedportrange protocol=tcp`).
#   OTK_TEST_PG_PORT=56032 OTK_TEST_REDIS_PORT=56979 OTK_TEST_SUBNET=172.31.230.0/24 \
#   docker compose -p otk-d1d8-1625-fps5 -f infra/test/docker-compose.services.yml -f infra/test/docker-compose.services.subnet.yml up -d
export OTK_TEST_PG_URL=postgres://otk:otk-test-only@127.0.0.1:56032/otk
export OTK_TEST_REDIS_URL=redis://:otk-test-only@127.0.0.1:56979
export OTK_TEST_PG_CONTAINER=otk-d1d8-1625-fps5-postgres-1

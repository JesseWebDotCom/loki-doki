#!/bin/bash
# Fixed entry point for the coding-sandbox sudoers rule (see
# lib/codingSandboxUser.ts). The sudoers.d rule grants NOPASSWD access to run
# exactly this script as the restricted coding-sandbox user: the security
# boundary is which OS identity the spawned agent process runs as (confined,
# no access to any home directory), not restricting what command reaches it,
# since the caller (this app's own backend) is already fully trusted. Kept
# generic (just execs whatever it's given) so it works for OpenCode today and
# any future coding-sidecar tool without a new sudoers rule per tool.
exec "$@"

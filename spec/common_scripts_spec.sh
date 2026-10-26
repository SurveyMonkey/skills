#!/bin/sh
# shellcheck shell=sh
# scripts/common/: select-adapter.sh.

Describe 'select-adapter.sh'
  It 'routes npm to the node adapter'
    When call common_jq select-adapter.sh '{ecosystem, supported, adapter, skip}' --ecosystem npm
    The status should be success
    The output should equal '{"ecosystem":"npm","supported":true,"adapter":"node","skip":false}'
  End

  It 'resolves an adapter path that exists and is executable'
    When call common_jq select-adapter.sh '.adapter_path' --ecosystem npm
    The status should be success
    The output should not include '..'
  End

  # Unsupported ecosystems are reported, never treated as an error: exit stays 0
  # and `supported` is false, so a caller handles them alongside "no fix
  # available" through one code path.
  Describe 'unsupported ecosystems are reported, not failed'
    Parameters
      pip
      rubygems
      maven
      go
      other
    End

    It "skips $1 without erroring"
      When call common_jq select-adapter.sh '{supported, skip, reason}' --ecosystem "$1"
      The status should be success
      The output should equal '{"supported":false,"skip":true,"reason":"ecosystem not supported yet"}'
    End
  End

  It 'carries the manifest path through'
    When call common_jq select-adapter.sh '.manifest' --ecosystem npm --manifest packages/web/package.json
    The status should be success
    The output should equal '"packages/web/package.json"'
  End

  It 'requires an ecosystem or batch mode'
    When run script "$COMMON/select-adapter.sh"
    The status should not equal 0
    The stderr should be present
  End

  It 'rejects unknown arguments'
    When run script "$COMMON/select-adapter.sh" --nope
    The status should not equal 0
    The stderr should be present
  End

  Describe 'batch mode over discovery JSON'
    discovery() {
      printf '%s' '{"actionable":[{"package":"lodash","ecosystem":"npm"},{"package":"rails","ecosystem":"rubygems"},{"package":"flask","ecosystem":"pip"}],"skipped":[{"package":"old","reason":"no fix available"}]}'
    }
    annotate() { discovery | "$COMMON/select-adapter.sh" --from-discovery | jq -c "$1"; }

    It 'keeps only supported ecosystems as actionable'
      When call annotate '[.actionable[] | {package, adapter}]'
      The status should be success
      The output should equal '[{"package":"lodash","adapter":"node"}]'
    End

    # The pre-existing skipped entry must survive: a caller reads one list.
    It 'moves unsupported groups into skipped without dropping existing ones'
      When call annotate '[.skipped[] | {package, reason}]'
      The status should be success
      The output should equal '[{"package":"old","reason":"no fix available"},{"package":"rails","reason":"ecosystem not supported yet"},{"package":"flask","reason":"ecosystem not supported yet"}]'
    End

    It 'rejects non-JSON on stdin'
      When run sh -c "printf 'not json' | '$COMMON/select-adapter.sh' --from-discovery"
      The status should not equal 0
      The stderr should be present
    End

    # Valid JSON of the wrong *shape* passes the `jq empty` guard and then
    # fails inside the annotation pipeline. Unwrapped, that left raw jq noise
    # on stderr and jq's own exit status where the adapter contract requires a
    # non-zero exit carrying `{"error": "..."}` (issue #39). The batch mode
    # read the stdout of `discover-alerts.sh`, which #231 retired. No caller
    # runs the batch mode now (#223 retires this script).
    malformed_shape() {
      printf '%s' '{"actionable":"oops","skipped":[]}' \
        | "$COMMON/select-adapter.sh" --from-discovery
    }

    It 'reports well-formed JSON of the wrong shape through the error contract'
      When call malformed_shape
      The status should not equal 0
      The stdout should equal ''
      The stderr should include '"error":"Failed to annotate discovery JSON'
    End

    # The batch-mode pipeline rebuilds the output object from the keys it
    # knows, so a top-level key it does not know about must survive the round
    # trip rather than being silently dropped.
    discovery_with_extra_key() {
      printf '%s' '{"actionable":[{"package":"lodash","ecosystem":"npm"}],"skipped":[],"extra":[{"note":"carried by the caller"}]}'
    }
    annotate_with_extra_key() { discovery_with_extra_key | "$COMMON/select-adapter.sh" --from-discovery | jq -c "$1"; }

    It 'passes an unknown top-level key through unchanged'
      When call annotate_with_extra_key '.extra'
      The status should be success
      The output should equal '[{"note":"carried by the caller"}]'
    End
  End
End

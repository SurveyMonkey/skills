#!/bin/sh
# shellcheck shell=sh
# scripts/common/detect-capacity.sh: concurrency cap from cores and total RAM.

Describe 'detect-capacity.sh'
  # The mocks read their answers from environment variables so one mock serves
  # every table row. Values are exported by the helpers below before the
  # script runs; the mock shims inherit them like any child process.
  Mock uname
    printf '%s\n' "${MOCK_OS:-}"
  End

  Mock sysctl
    case "$*" in
      '-n hw.ncpu')    printf '%s\n' "${MOCK_NCPU:-}"; [ -n "${MOCK_NCPU:-}" ] || return 1 ;;
      '-n hw.memsize') printf '%s\n' "${MOCK_MEMSIZE:-}"; [ -n "${MOCK_MEMSIZE:-}" ] || return 1 ;;
      *) return 1 ;;
    esac
  End

  Mock nproc
    printf '%s\n' "${MOCK_NPROC:-}"
    [ -n "${MOCK_NPROC:-}" ] || return 1
  End

  darwin() {
    MOCK_OS=Darwin MOCK_NCPU=$1 MOCK_MEMSIZE=$2
    export MOCK_OS MOCK_NCPU MOCK_MEMSIZE
    "$COMMON/detect-capacity.sh" | jq -c "$3"
  }

  linux() {
    MOCK_OS=Linux MOCK_NPROC=$1
    export MOCK_OS MOCK_NPROC
    "$COMMON/detect-capacity.sh" "$2" | jq -c "$3"
  }

  # cap = clamp(min(floor(cores / 3), floor(total_ram_gb / 8)), 3, 6).
  # Memory arrives from sysctl in bytes.
  Describe 'clamp math on Darwin'
    Parameters
      # cores  hw.memsize      expected
      8        17179869184     '{"cap":3,"cores_slots":2,"ram_slots":2,"limited_by":"floor"}'
      24       68719476736     '{"cap":6,"cores_slots":8,"ram_slots":8,"limited_by":"ceiling"}'
      12       51539607552     '{"cap":4,"cores_slots":4,"ram_slots":6,"limited_by":"cores"}'
      18       42949672960     '{"cap":5,"cores_slots":6,"ram_slots":5,"limited_by":"ram"}'
      12       34359738368     '{"cap":4,"cores_slots":4,"ram_slots":4,"limited_by":"cores"}'
    End

    It "caps $1 cores / $2 bytes"
      When call darwin "$1" "$2" '{cap, cores_slots, ram_slots, limited_by}'
      The status should be success
      The output should equal "$3"
    End
  End

  It 'reports the detected totals alongside the cap'
    When call darwin 12 51539607552 '{cores, total_ram_gb, fallback}'
    The status should be success
    The output should equal '{"cores":12,"total_ram_gb":48,"fallback":false}'
  End

  Describe 'Linux reads nproc and MemTotal'
    meminfo() {
      printf 'MemTotal:       %s kB\nMemFree:        1024 kB\n' "$1" \
        > "$SHELLSPEC_WORKDIR/meminfo"
      printf '%s\n' "$SHELLSPEC_WORKDIR/meminfo"
    }

    It 'derives the cap from kB'
      # 33554432 kB = 32 GB -> ram_slots 4; 12 cores -> cores_slots 4.
      When call linux 12 "$(meminfo 33554432)" '{cap, cores, total_ram_gb, limited_by}'
      The status should be success
      The output should equal '{"cap":4,"cores":12,"total_ram_gb":32,"limited_by":"cores"}'
    End
  End

  # Any detection failure produces the fallback cap of 3 and exits 0. A cap of
  # 3 is a usable answer; a cap derived from garbage is not.
  Describe 'fallback'
    fallback_case() {
      MOCK_OS=$1 MOCK_NCPU=$2 MOCK_MEMSIZE=$3 MOCK_NPROC=$4
      export MOCK_OS MOCK_NCPU MOCK_MEMSIZE MOCK_NPROC
      "$COMMON/detect-capacity.sh" "$5" | jq -c '{cap, limited_by, fallback}'
    }

    Describe 'every failed read'
      Parameters
        # description                 os      ncpu     memsize      nproc  meminfo
        'an unsupported OS'           SunOS   ''       ''           ''     /proc/meminfo
        'uname producing no output'   ''      ''       ''           ''     /proc/meminfo
        'non-numeric sysctl output'   Darwin  garbage  17179869184  ''     /proc/meminfo
        'a failing sysctl'            Darwin  ''       ''           ''     /proc/meminfo
        'non-numeric nproc output'    Linux   ''       ''           what   /proc/meminfo
        'a missing meminfo file'      Linux   ''       ''           8      /nonexistent
      End

      It "falls back to 3 on $1"
        When call fallback_case "$2" "$3" "$4" "$5" "$6"
        The status should be success
        The output should equal '{"cap":3,"limited_by":"fallback","fallback":true}'
      End
    End

    It 'names the failing read in fallback_reason'
      MOCK_OS=Darwin MOCK_NCPU=garbage MOCK_MEMSIZE=17179869184
      export MOCK_OS MOCK_NCPU MOCK_MEMSIZE
      When call common_jq detect-capacity.sh '.fallback_reason'
      The status should be success
      The output should include 'hw.ncpu'
    End
  End
End

// SPDX-License-Identifier: AGPL-3.0-or-later
package com.smartperfetto.e2e

import android.os.Trace
import java.io.File

/**
 * Stable constructed source fixture for request-scoped source retrieval.
 * It is compatible with the paired synthetic Trace markers, but is not proof
 * that an Android APK containing this file produced the captured base Trace.
 */
object StartupHooks {
  const val SOURCE_CONTEXT_MARKER = "E2E_CONTEXT_MARKER_SOURCE"
  const val TRACE_SOURCE_MARKER = "StartupHooks.initializeOnMainThread#before-first-frame-sync-policy"
  const val FIRST_FRAME_TRACE_MARKER = "StartupHooks.onFirstFrame#synthetic-first-frame-boundary"

  fun initializeOnMainThread(policyFile: File) { // SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT
    Trace.beginSection(TRACE_SOURCE_MARKER)
    try {
      val startupPolicy = readStartupPolicySynchronously(policyFile)
      check(startupPolicy.isNotEmpty())
    } finally {
      Trace.endSection()
    }
  }

  private fun readStartupPolicySynchronously(policyFile: File): String {
    return policyFile.readText()
  }

  fun onFirstFrame() {
    Trace.beginSection(FIRST_FRAME_TRACE_MARKER)
    Trace.endSection()
  }
}

/** Synthetic caller retained in the bounded fixture so the call-chain assertion is source-backed. */
object Application {
  fun onCreate(filesDir: File) {
    val policyFile = File(filesDir, "startup-policy.txt")
    StartupHooks.initializeOnMainThread(policyFile)
  }

  fun onFirstFrame() {
    StartupHooks.onFirstFrame()
  }
}

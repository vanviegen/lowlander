package com.lowlander.client

internal object Protocol {
    // Server → client message tags (single-char strings)
    const val S_ERROR = "e"
    const val S_RESPONSE = "r"
    const val S_RESPONSE_PROXY = "p"
    const val S_RESPONSE_MODEL = "m"
    const val S_RESPONSE_PROXY_MODEL = "q"
    const val S_MODEL_DATA = "d"

    // Client → server message tags (small ints)
    const val C_CALL = 1L
    const val C_CANCEL = 2L
}

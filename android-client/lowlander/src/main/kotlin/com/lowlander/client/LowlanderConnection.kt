package com.lowlander.client

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlin.math.pow

typealias Callback = (List<Any?>) -> Unit

/**
 * Status of an in-flight Lowlander request.
 *
 * - [Loading]: request sent (or queued for reconnect); no response yet
 * - [Success]: response arrived; for streams, [ResultHandle.value] is live-updating
 * - [Error]: server returned an error
 */
sealed class Status {
    object Loading : Status()
    object Success : Status()
    data class Error(val message: String) : Status()
}

/**
 * Handle for an RPC call. Holds reactive state ([status], [value]) for Compose, plus
 * a [promise] for one-shot coroutine awaiting. Stream subscriptions stay live for the
 * lifetime of the handle; call [cancel] (or let the owning [LowlanderConnection] close)
 * to release server-side resources.
 */
class ResultHandle internal constructor(
    internal val connection: LowlanderConnection,
    internal val requestId: Int,
    internal val proxyId: Int?,
) {
    private val _status: MutableState<Status> = mutableStateOf(Status.Loading)
    /** Reactive status; safe to read from `@Composable`. */
    val status: Status get() = _status.value

    private val _rootState: MutableState<Any?> = mutableStateOf(null)
    /** Reactive view into the result. For scalar responses, `value.raw` holds the value;
     *  for streamed models, `value.getMap(...)` etc. traverse the live tree. */
    val value: StreamValue = StreamValue.fromState(_rootState)

    private val deferred = CompletableDeferred<Any?>()
    /** Suspends until the first response (or error). Returns the raw value. */
    suspend fun await(): Any? = deferred.await()

    /** Sugar for `await()`. */
    val promise: CompletableDeferred<Any?> get() = deferred

    internal var virtualSocketIds: List<Long>? = null
    internal var hasServerProxy: Boolean = false
    internal val database = ConcurrentHashMap<Long, SnapshotStateMap<Any, Any?>>()
    internal val commitIds = ConcurrentHashMap<Long, MutableMap<Any, Long>>()
    internal var callbacks: List<Callback>? = null
    internal var cacheKey: String? = null
    internal var requestBuffer: ByteArray = ByteArray(0)

    internal fun deliverScalar(v: Any?) {
        _rootState.value = v
        _status.value = Status.Success
        if (!deferred.isCompleted) deferred.complete(v)
    }

    internal fun deliverModel(rootMap: SnapshotStateMap<Any, Any?>) {
        _rootState.value = rootMap
        _status.value = Status.Success
        if (!deferred.isCompleted) deferred.complete(rootMap)
    }

    internal fun deliverError(msg: String) {
        _status.value = Status.Error(msg)
        if (!deferred.isCompleted) deferred.completeExceptionally(RuntimeException(msg))
    }

    /**
     * Call a method on the server-side proxy associated with this result (only valid
     * when the server returned a [ServerProxy]).
     */
    fun proxy(method: String, vararg args: Any?): ResultHandle =
        connection.call(method, args.toList(), proxyId = requestId)

    /** Cancels the request and releases any server-side subscription. */
    fun cancel() = connection.cancel(this)
}

/**
 * WebSocket connection to a Lowlander server.
 *
 * Connects asynchronously; reconnects with exponential backoff on close/error. Call
 * `api.call("methodName", arg1, arg2, ...)` to issue RPCs. Pass a Kotlin function
 * (e.g. `{ args -> ... }`) as an argument to register a server-side `Socket<T>` callback.
 *
 * @param url ws:// or wss:// URL
 * @param httpClient optional OkHttp client (provide your own to share connection pools / tune timeouts)
 */
class LowlanderConnection(
    private val url: String,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(30, java.util.concurrent.TimeUnit.SECONDS)
        .build(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val active = ConcurrentHashMap<Int, ResultHandle>()
    private val requestCounter = AtomicInteger(0)
    private var ws: WebSocket? = null
    private val onlineState = mutableStateOf(false)
    private var reconnectAttempts = 0
    @Volatile private var closed = false

    /** Reactive online flag; read inside `@Composable` to auto-update. */
    fun isOnline(): Boolean = onlineState.value

    /** Convenience facade — `connection.api.call("method", arg1, arg2)`. */
    val api: Api = Api(this)

    init { connect() }

    private fun connect() {
        if (closed) return
        Log.d("LowlanderWS", "Connecting to $url")
        val req = Request.Builder().url(url.replace("ws://", "http://").replace("wss://", "https://")).build()
        ws = httpClient.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("LowlanderWS", "Connected! response=${response.code}")
                onlineState.value = true
                reconnectAttempts = 0
                // Re-send all in-flight requests
                for (h in active.values) webSocket.send(ByteString.of(*h.requestBuffer))
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                handleIncoming(bytes.toByteArray())
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("LowlanderWS", "Closed: $code $reason")
                scheduleReconnect()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("LowlanderWS", "Failed: ${t.javaClass.simpleName}: ${t.message}", t)
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        onlineState.value = false
        ws = null
        if (closed) return
        val delayMs = min(500.0 * 2.0.pow(reconnectAttempts), 20000.0).toLong()
        reconnectAttempts++
        scope.launch { delay(delayMs); connect() }
    }

    /** Closes the connection and cancels all in-flight requests. */
    fun close() {
        closed = true
        ws?.close(1000, null); ws = null
        active.clear()
    }

    // -------------------------------------------------------- request sending

    internal fun call(method: String, params: List<Any?>, proxyId: Int? = null): ResultHandle {
        val id = requestCounter.incrementAndGet()
        val handle = ResultHandle(this, id, proxyId)
        val pack = DataPack()
        pack.write(id.toLong()).write(Protocol.C_CALL)
        if (proxyId == null) pack.writeUndefined() else pack.write(proxyId.toLong())
        pack.write(method)
        pack.writeArrayStart()
        val cbs = mutableListOf<Callback>()
        for (p in params) {
            if (p is Function1<*, *>) {
                @Suppress("UNCHECKED_CAST")
                pack.writeCustom("cb", cbs.size.toLong())
                cbs.add(p as Callback)
            } else pack.write(p)
        }
        pack.writeEnd()
        handle.callbacks = if (cbs.isEmpty()) null else cbs
        handle.requestBuffer = pack.toByteArray()
        active[id] = handle
        ws?.let { it.send(ByteString.of(*handle.requestBuffer)) }
        return handle
    }

    internal fun cancel(handle: ResultHandle) {
        active.remove(handle.requestId)
        if (handle.virtualSocketIds?.isNotEmpty() == true || handle.hasServerProxy) {
            val pack = DataPack()
            pack.write(requestCounter.incrementAndGet().toLong())
                .write(Protocol.C_CANCEL)
                .write(handle.requestId.toLong())
                .write(handle.virtualSocketIds)
            ws?.send(ByteString.of(*pack.toByteArray()))
        }
    }

    // ----------------------------------------------------- incoming dispatch

    private fun handleIncoming(data: ByteArray) {
        val pack = DataPack(data)
        val requestId = pack.readLong().toInt()
        val handle = active[requestId] ?: return
        val typeRaw = pack.readAny()

        if (typeRaw is Number) {
            // Callback invocation
            val cb = handle.callbacks?.getOrNull(typeRaw.toInt()) ?: return
            val args = mutableListOf<Any?>()
            while (pack.available()) args.add(pack.readAny())
            cb(args); return
        }

        val type = typeRaw as String
        when (type) {
            Protocol.S_ERROR -> {
                handle.deliverError(pack.readString())
                if (!handle.hasServerProxy && handle.virtualSocketIds.isNullOrEmpty()) active.remove(requestId)
            }
            Protocol.S_RESPONSE, Protocol.S_RESPONSE_PROXY -> {
                val v = pack.readAny()
                @Suppress("UNCHECKED_CAST")
                handle.virtualSocketIds = (pack.readAny() as? List<Any?>)?.mapNotNull { (it as? Number)?.toLong() }
                handle.hasServerProxy = type == Protocol.S_RESPONSE_PROXY
                handle.deliverScalar(v)
                if (!handle.hasServerProxy && handle.virtualSocketIds.isNullOrEmpty()) active.remove(requestId)
            }
            Protocol.S_RESPONSE_MODEL, Protocol.S_RESPONSE_PROXY_MODEL -> {
                @Suppress("UNCHECKED_CAST")
                handle.virtualSocketIds = (pack.readAny() as? List<Any?>)?.mapNotNull { (it as? Number)?.toLong() }
                val dbKey = pack.readLong()
                pack.readAny() // cacheMs (unused on Android client)
                handle.hasServerProxy = type == Protocol.S_RESPONSE_PROXY_MODEL
                val obj = handle.database[dbKey]
                if (obj != null) handle.deliverModel(obj)
                else handle.deliverError("Unknown database key $dbKey")
            }
            Protocol.S_MODEL_DATA -> applyModelData(handle, pack)
            else -> throw IllegalStateException("Unknown message type $type")
        }
    }

    private fun applyModelData(handle: ResultHandle, pack: DataPack) {
        val dbKeyHash = pack.readLong()
        val commitId = pack.readLong()
        val converters = mapOf<String, (Any?) -> Any?>(
            "model" to { linkHashRaw ->
                val linkHash = (linkHashRaw as Number).toLong()
                handle.database.getOrPut(linkHash) { SnapshotStateMap() }
            }
        )
        val delta = pack.readAny(converters)
        val prev = handle.commitIds[dbKeyHash]

        if (delta == null || delta == false) {
            val latest = prev?.values?.maxOrNull() ?: -1L
            if (prev != null && commitId < latest) return
            handle.database.remove(dbKeyHash)
            handle.commitIds[dbKeyHash] = mutableMapOf<Any, Long>(DEFAULT_COMMIT to commitId)
            return
        }

        @Suppress("UNCHECKED_CAST")
        val deltaMap = delta as? Map<Any, Any?>
            ?: throw IllegalStateException("Expected object delta, got ${delta::class.simpleName}")

        val existing = handle.database[dbKeyHash]
        if (existing != null) {
            val tracker = prev ?: mutableMapOf<Any, Long>().also { handle.commitIds[dbKeyHash] = it }
            for ((k, v) in deltaMap) {
                val keyCommit = tracker[k] ?: tracker[DEFAULT_COMMIT] ?: -1L
                if (commitId < keyCommit) continue
                if (v != null && v !is SnapshotStateMap<*, *> && (v is Map<*, *> || v is List<*>)) {
                    deepMerge(existing, k, v)
                } else {
                    existing[k] = convertToSnapshot(v)
                }
                tracker[k] = commitId
            }
        } else {
            val defaultCommit = prev?.get(DEFAULT_COMMIT) ?: -1L
            if (commitId < defaultCommit) return
            val map = SnapshotStateMap<Any, Any?>()
            for ((k, v) in deltaMap) map[k] = convertToSnapshot(v)
            handle.database[dbKeyHash] = map
            handle.commitIds[dbKeyHash] = mutableMapOf<Any, Long>(DEFAULT_COMMIT to commitId)
        }
    }

    /** Convert deserialized data (Map/List/scalar/linked-model-ref) to Snapshot-backed equivalents. */
    private fun convertToSnapshot(v: Any?): Any? = when (v) {
        is SnapshotStateMap<*, *> -> v // already a linked-model reference
        is Map<*, *> -> {
            val m = SnapshotStateMap<Any, Any?>()
            for ((k, vv) in v) if (k != null) m[k] = convertToSnapshot(vv)
            m
        }
        is List<*> -> {
            val l = SnapshotStateList<Any?>()
            for (item in v) l.add(convertToSnapshot(item))
            l
        }
        else -> v
    }

    /** Deep-merge `src` into `dst[key]`, preserving existing SnapshotStateMap/List identity where possible. */
    @Suppress("UNCHECKED_CAST")
    private fun deepMerge(dst: SnapshotStateMap<Any, Any?>, key: Any, src: Any?) {
        val existing = dst[key]
        when {
            src is Map<*, *> && existing is SnapshotStateMap<*, *> -> {
                val em = existing as SnapshotStateMap<Any, Any?>
                for ((k, v) in src) if (k != null) {
                    if (v is Map<*, *> || v is List<*>) deepMerge(em, k, v)
                    else em[k] = convertToSnapshot(v)
                }
            }
            src is List<*> && existing is SnapshotStateList<*> -> {
                val el = existing as SnapshotStateList<Any?>
                // Resize then patch elements that differ
                while (el.size > src.size) el.removeAt(el.size - 1)
                src.forEachIndexed { i, v ->
                    val cv = convertToSnapshot(v)
                    if (i < el.size) { if (el[i] != cv) el[i] = cv } else el.add(cv)
                }
            }
            else -> dst[key] = convertToSnapshot(src)
        }
    }

    companion object {
        private val DEFAULT_COMMIT = Any() // sentinel
    }
}

/** Thin facade so call sites read `connection.api.call(...)` like the JS version. */
class Api internal constructor(private val conn: LowlanderConnection) {
    fun call(method: String, vararg args: Any?): ResultHandle = conn.call(method, args.toList())
}

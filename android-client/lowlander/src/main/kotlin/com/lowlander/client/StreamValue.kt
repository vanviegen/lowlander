package com.lowlander.client

import androidx.compose.runtime.State
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap

/**
 * Reactive view into a streamed object tree.
 *
 * The underlying storage is a tree of [SnapshotStateMap] / [SnapshotStateList]; reading
 * these inside a `@Composable` automatically subscribes that composable to changes at
 * exactly the leaves it touched, so the server can push fine-grained deltas that result
 * in fine-grained recomposition.
 *
 * Path accessors traverse the tree by string/int keys. Missing segments yield empty
 * containers (no exception); unexpected types at a segment throw [TypeMismatchException].
 *
 * Note: instances are cheap value wrappers; do not cache across recompositions in a way
 * that prevents Compose from re-reading the underlying state.
 */
class StreamValue internal constructor(private val rootRef: () -> Any?) {

    class TypeMismatchException(msg: String) : RuntimeException(msg)
    class MissingException(msg: String) : RuntimeException(msg)

    /** Raw current value (any of: scalar, [SnapshotStateMap], [SnapshotStateList], null). */
    val raw: Any? get() = rootRef()

    /** True if all path segments resolve to a present (non-null) value. */
    fun exists(vararg path: Any): Boolean = walk(path) != null

    fun getStr(vararg path: Any): String = walk(path) as? String
        ?: throw TypeMismatchException("Expected string at ${path.joinToString("/")}")
    fun getStrOrNull(vararg path: Any): String? = walk(path) as? String

    fun getInt(vararg path: Any): Long {
        val v = walk(path) ?: throw MissingException(path.joinToString("/"))
        return (v as? Number)?.toLong()
            ?: throw TypeMismatchException("Expected int at ${path.joinToString("/")}, got ${v::class.simpleName}")
    }
    fun getIntOrNull(vararg path: Any): Long? = (walk(path) as? Number)?.toLong()

    fun getDouble(vararg path: Any): Double = (walk(path) as? Number)?.toDouble()
        ?: throw TypeMismatchException("Expected number at ${path.joinToString("/")}")

    fun getBool(vararg path: Any): Boolean = walk(path) as? Boolean
        ?: throw TypeMismatchException("Expected boolean at ${path.joinToString("/")}")
    fun getBoolOrNull(vararg path: Any): Boolean? = walk(path) as? Boolean

    /** Returns a sub-view at the given path. If absent, returns an empty (always-null) view. */
    fun getMap(vararg path: Any): StreamValue {
        val node = walk(path)
        if (node == null) return StreamValue { null }
        if (node !is SnapshotStateMap<*, *>)
            throw TypeMismatchException("Expected map at ${path.joinToString("/")}, got ${node::class.simpleName}")
        return StreamValue { walk(path) } // re-walk per access so updates remain reactive
    }

    /** Returns a list of sub-views at the given path. Empty list if absent. */
    fun getList(vararg path: Any): List<StreamValue> {
        val node = walk(path) ?: return emptyList()
        if (node !is SnapshotStateList<*>)
            throw TypeMismatchException("Expected list at ${path.joinToString("/")}, got ${node::class.simpleName}")
        @Suppress("UNCHECKED_CAST")
        val list = node as SnapshotStateList<Any?>
        return List(list.size) { idx -> StreamValue { (walk(path) as? SnapshotStateList<*>)?.getOrNull(idx) } }
    }

    /** Keys present at the given map path, in insertion order. Empty if absent. */
    fun keys(vararg path: Any): List<Any> {
        val node = walk(path) ?: return emptyList()
        if (node !is SnapshotStateMap<*, *>) return emptyList()
        return node.keys.toList().filterNotNull()
    }

    // ------------------------------------------------------------- internals

    private fun walk(path: Array<out Any>): Any? {
        var cur: Any? = rootRef()
        for (seg in path) {
            cur = when (cur) {
                null -> return null
                is SnapshotStateMap<*, *> -> {
                    @Suppress("UNCHECKED_CAST")
                    val m = cur as SnapshotStateMap<Any, Any?>
                    // Server's writeObjectKey may have coerced numeric strings to numbers, so
                    // try multiple key shapes.
                    val str = seg.toString()
                    val asLong = (seg as? Number)?.toLong() ?: str.toLongOrNull()
                    m[seg] ?: m[str] ?: (asLong?.let { m[it] })
                }
                is SnapshotStateList<*> -> {
                    val idx = when (seg) { is Number -> seg.toInt(); is String -> seg.toIntOrNull() ?: return null; else -> return null }
                    if (idx < 0 || idx >= cur.size) return null else cur[idx]
                }
                else -> throw TypeMismatchException("Cannot descend into ${cur::class.simpleName} with $seg")
            }
        }
        return cur
    }

    companion object {
        internal fun fromState(state: State<Any?>): StreamValue = StreamValue { state.value }
    }
}

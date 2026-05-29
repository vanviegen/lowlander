package com.lowlander.client

import java.nio.charset.StandardCharsets

/**
 * Kotlin port of Edinburgh's DataPack binary format.
 *
 * Reads/writes the same self-describing tagged byte format used by the JS client.
 * Containers (arrays/objects/maps/sets) are bounded by start/EOD markers.
 *
 * For interop with the Lowlander server:
 *  - JS `number` round-trips as `Long` (when integral) or `Double` (otherwise).
 *  - JS `object` round-trips as `LinkedHashMap<Any, Any?>` (string-or-number keys).
 *  - JS `Map` round-trips as a tagged Map via [readAny]/`MapMarker` (rarely used here).
 *  - `null` and `undefined` both come back as `null` (distinguishable only by parser state).
 */
class DataPack(initial: ByteArray? = null) {
    private var buf: ByteArray = initial ?: ByteArray(256)
    var writePos: Int = initial?.size ?: 0
    var readPos: Int = 0

    /** Marker for end-of-collection while iterating with low-level reads. */
    object EOD

    /** Wraps a deserialized JS Map (vs plain object). */
    class TaggedMap(val entries: LinkedHashMap<Any?, Any?>)

    /** Wraps a custom (named) value: type 4/13. The `model` custom type is resolved by [readAny] hooks. */
    class CustomData(val name: String, val data: Any?)

    private fun ensure(n: Int) {
        if (writePos + n <= buf.size) return
        var cap = buf.size
        while (cap < writePos + n) cap = (cap * 3) / 2 + 16
        buf = buf.copyOf(cap)
    }

    fun toByteArray(): ByteArray = buf.copyOf(writePos)
    fun available(): Boolean = readPos < writePos

    // ------------------------------------------------------------------ writers

    fun write(v: Any?): DataPack {
        ensure(33)
        when (v) {
            null -> buf[writePos++] = ((4 shl 5) or 2).toByte()       // null
            is Boolean -> buf[writePos++] = ((4 shl 5) or (if (v) 3 else 4)).toByte()
            is Byte -> writeLong(v.toLong())
            is Short -> writeLong(v.toLong())
            is Int -> writeLong(v.toLong())
            is Long -> writeLong(v)
            is Float -> writeDouble(v.toDouble())
            is Double -> {
                if (v == Math.floor(v) && !v.isInfinite() && v >= Long.MIN_VALUE.toDouble() && v <= Long.MAX_VALUE.toDouble()) {
                    writeLong(v.toLong())
                } else writeDouble(v)
            }
            is String -> writeString(v)
            is ByteArray -> writeBlob(v)
            is Map<*, *> -> {
                buf[writePos++] = ((4 shl 5) or 6).toByte() // object
                for ((k, vv) in v) {
                    when (k) {
                        is String -> write(k); is Number -> write(k); else -> write(k.toString())
                    }
                    write(vv)
                }
                ensure(1); buf[writePos++] = ((4 shl 5) or 9).toByte()
            }
            is Iterable<*> -> {
                buf[writePos++] = ((4 shl 5) or 5).toByte() // array
                for (it in v) write(it)
                ensure(1); buf[writePos++] = ((4 shl 5) or 9).toByte()
            }
            is Array<*> -> {
                buf[writePos++] = ((4 shl 5) or 5).toByte()
                for (it in v) write(it)
                ensure(1); buf[writePos++] = ((4 shl 5) or 9).toByte()
            }
            is CustomData -> {
                buf[writePos++] = ((4 shl 5) or 13).toByte()
                write(v.name); write(v.data)
            }
            else -> throw IllegalArgumentException("Unsupported type: ${v::class}")
        }
        return this
    }

    fun writeUndefined(): DataPack { ensure(1); buf[writePos++] = ((4 shl 5) or 1).toByte(); return this }

    private fun writeLong(v: Long) {
        ensure(9)
        if (v >= 0) {
            when {
                v < 32 -> buf[writePos++] = ((1 shl 5) or v.toInt()).toByte()
                v < 64 -> buf[writePos++] = ((2 shl 5) or (v.toInt() - 32)).toByte()
                else -> writeMulti(v - 64, 3, invertBytes = false, invertCount = false)
            }
        } else {
            writeMulti(-v, 0, invertBytes = true, invertCount = true)
        }
    }

    private fun writeDouble(v: Double) {
        ensure(9)
        buf[writePos++] = ((4 shl 5) or 0).toByte()
        val bits = java.lang.Double.doubleToRawLongBits(v)
        for (i in 7 downTo 0) buf[writePos++] = ((bits ushr (i * 8)) and 0xFF).toByte()
    }

    private fun writeMulti(value: Long, headerType: Int, invertBytes: Boolean, invertCount: Boolean) {
        var bc = 0; var t = value
        while (t > 0) { bc++; t = t ushr 8 }
        val encCount = if (invertCount) (bc.inv() and 0x1F) else bc
        buf[writePos++] = ((headerType shl 5) or encCount).toByte()
        for (i in bc - 1 downTo 0) {
            var b = ((value ushr (i * 8)) and 0xFF).toInt()
            if (invertBytes) b = b xor 0xFF
            buf[writePos++] = b.toByte()
        }
    }

    private fun writeString(s: String) {
        val bytes = s.toByteArray(StandardCharsets.UTF_8)
        if (bytes.size < 32) {
            ensure(1 + bytes.size)
            buf[writePos++] = ((5 shl 5) or bytes.size).toByte()
        } else {
            writeMulti(bytes.size.toLong(), 6, invertBytes = false, invertCount = false)
            ensure(bytes.size)
        }
        System.arraycopy(bytes, 0, buf, writePos, bytes.size); writePos += bytes.size
    }

    private fun writeBlob(b: ByteArray) {
        writeMulti(b.size.toLong(), 7, invertBytes = false, invertCount = false)
        ensure(b.size); System.arraycopy(b, 0, buf, writePos, b.size); writePos += b.size
    }

    /** Write a custom value with a name tag. Used to send callback references (`cb` + index). */
    fun writeCustom(name: String, data: Any?): DataPack {
        ensure(1); buf[writePos++] = ((4 shl 5) or 13).toByte()
        write(name); write(data); return this
    }

    fun writeArrayStart() { ensure(1); buf[writePos++] = ((4 shl 5) or 5).toByte() }
    fun writeEnd() { ensure(1); buf[writePos++] = ((4 shl 5) or 9).toByte() }

    // ------------------------------------------------------------------ readers

    /**
     * Reads one value. `customConverters` lets callers intercept `CustomData` names
     * (used for resolving linked-model references in deltas).
     */
    fun readAny(customConverters: Map<String, (Any?) -> Any?>? = null): Any? {
        if (readPos >= writePos) throw IllegalStateException("Not enough data")
        val header = buf[readPos++].toInt() and 0xFF
        val type = (header shr 5) and 0x07
        val sub = header and 0x1F
        return when (type) {
            0 -> -readMulti((sub.inv()) and 0x1F, invert = true)
            1 -> sub.toLong()
            2 -> (sub + 32).toLong()
            3 -> readMulti(sub, invert = false) + 64
            4 -> when (sub) {
                0 -> readDouble()
                1 -> null   // undefined
                2 -> null
                3 -> true
                4 -> false
                5 -> {      // array
                    val out = ArrayList<Any?>()
                    while (true) {
                        val v = readAny(customConverters)
                        if (v === EOD) break
                        out.add(v)
                    }
                    out
                }
                6 -> {      // object (plain) — string/number keys
                    val out = LinkedHashMap<Any, Any?>()
                    while (true) {
                        val k = readAny(customConverters)
                        if (k === EOD) break
                        val v = readAny(customConverters)
                        out[k as Any] = v
                    }
                    out
                }
                7 -> {      // Map
                    val out = LinkedHashMap<Any?, Any?>()
                    while (true) {
                        val k = readAny(customConverters); if (k === EOD) break
                        val v = readAny(customConverters); out[k] = v
                    }
                    TaggedMap(out)
                }
                8 -> {      // Set
                    val out = LinkedHashSet<Any?>()
                    while (true) {
                        val v = readAny(customConverters); if (v === EOD) break
                        out.add(v)
                    }
                    out
                }
                9 -> EOD
                10 -> { readPos--; readIdentifier() }
                11 -> {     // null-terminated string
                    val start = readPos
                    var end = start
                    while (end < writePos && buf[end] != 0.toByte()) end++
                    if (end >= writePos) throw IllegalStateException("Unterminated string")
                    readPos = end + 1
                    String(buf, start, end - start, StandardCharsets.UTF_8)
                }
                12 -> {     // Date
                    val secs = (readAny(customConverters) as Number).toLong()
                    java.util.Date(secs * 1000L)
                }
                13 -> {
                    val name = readString()
                    val data = readAny(customConverters)
                    val cvt = customConverters?.get(name)
                    if (cvt != null) cvt(data) else CustomData(name, data)
                }
                else -> throw IllegalStateException("Unknown 4/$sub")
            }
            5 -> readBytesAsString(sub)
            6 -> readBytesAsString(readMulti(sub, invert = false).toInt())
            7 -> {
                val len = readMulti(sub, invert = false).toInt()
                val out = ByteArray(len)
                System.arraycopy(buf, readPos, out, 0, len); readPos += len; out
            }
            else -> throw IllegalStateException("Unknown type $type")
        }
    }

    private fun readMulti(byteCount: Int, invert: Boolean): Long {
        var v = 0L
        for (i in 0 until byteCount) {
            var b = buf[readPos + i].toInt() and 0xFF
            if (invert) b = b xor 0xFF
            v = (v shl 8) or b.toLong()
        }
        readPos += byteCount
        return v
    }

    private fun readDouble(): Double {
        var bits = 0L
        for (i in 0 until 8) bits = (bits shl 8) or (buf[readPos + i].toLong() and 0xFF)
        readPos += 8
        return java.lang.Double.longBitsToDouble(bits)
    }

    private fun readBytesAsString(len: Int): String {
        val s = String(buf, readPos, len, StandardCharsets.UTF_8); readPos += len; return s
    }

    fun readNumber(): Double {
        val v = readAny() ?: throw IllegalStateException("Expected number, got null")
        return (v as Number).toDouble()
    }
    fun readLong(): Long = (readAny() as Number).toLong()
    fun readString(): String = readAny() as String
    fun readPositiveInt(): Long {
        val v = readLong()
        if (v < 0) throw IllegalStateException("Expected positive int, got $v")
        return v
    }

    private fun readIdentifier(): String {
        val header = buf[readPos++].toInt() and 0xFF
        if (header != ((4 shl 5) or 10)) throw IllegalStateException("Invalid identifier header")
        var num = 0L
        for (i in 0 until 6) num = (num shl 8) or (buf[readPos++].toLong() and 0xFF)
        val chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"
        val sb = StringBuilder(8)
        for (i in 0 until 8) {
            sb.insert(0, chars[(num and 0x3F).toInt()])
            num = num ushr 6
        }
        return sb.toString()
    }

    companion object {
        fun create(vararg args: Any?): ByteArray {
            val p = DataPack()
            for (a in args) p.write(a)
            return p.toByteArray()
        }
    }
}

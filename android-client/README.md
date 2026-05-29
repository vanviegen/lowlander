# Lowlander Android Client

Kotlin/Android client for [Lowlander](../README.md) servers. Provides type-erased RPC,
streaming, and Jetpack Compose integration with fine-grained reactivity over
server-pushed deltas.

> Status: experimental. API may change. Tracks the same wire protocol as the JS client.

## Install

```kotlin
// settings.gradle.kts
include(":lowlander")
project(":lowlander").projectDir = file("path/to/lowlander/android-client/lowlander")
```

Min SDK 24, Kotlin 2.0, Jetpack Compose.

Depends on OkHttp (WebSocket transport), kotlinx.coroutines, and
`androidx.compose.runtime` (for `SnapshotStateMap`/`SnapshotStateList`).

## Usage

### Connect

```kotlin
val connection = LowlanderConnection("ws://10.0.2.2:8080/")

@Composable fun StatusBar() {
    Text(if (connection.isOnline()) "online" else "offline")
}
```

Reconnect is automatic with exponential backoff. Call `connection.close()` on shutdown.

### Plain RPC

```kotlin
val result = connection.api.call("add", 5, 6)
val sum = result.await() as Long   // suspend
```

Or reactively inside a composable:

```kotlin
@Composable fun Sum() {
    val r = remember { connection.api.call("add", 5, 6) }
    when (val s = r.status) {
        Status.Loading -> Text("...")
        is Status.Error -> Text("err: ${s.message}")
        Status.Success -> Text("= ${r.value.raw}")
    }
}
```

### Streaming a model

```kotlin
val person = connection.api.call("streamPerson", "Alice")

@Composable fun PersonView() {
    // Fine-grained: only this Text recomposes when 'name' changes
    Text(person.value.getStr("name"))
    Text("age: ${person.value.getIntOrNull("age") ?: 0}")

    // Linked-model lists: iterate sub-views; each item's leaves are tracked independently
    for (friend in person.value.getList("friends")) {
        Text(friend.getStr("name"))
    }
}
```

Path traversal rules:

- Missing intermediate keys → empty `StreamValue` / empty list (no exception).
- Type mismatch → `StreamValue.TypeMismatchException`.
- Scalar accessors (`getStr`, `getInt`, ...) throw on missing; use the `*OrNull`
  variants for nullable lookups.
- `getMap(...)` / `getList(...)` / `getStr(...)` accept a varargs path of `String`
  or `Int`/`Long` segments: `value.getStr("game", "users", userId, "name")`.

### Server callbacks (`Socket<T>` on the server)

Pass a Kotlin lambda as a parameter. It will be invoked each time the server calls
`socket.send(...)`:

```kotlin
connection.api.call("streamNumbers", { args -> println("num: ${args[0]}") })
```

### ServerProxy (stateful APIs)

```kotlin
val auth = connection.api.call("authenticate", "token")
val secret = auth.await()              // value returned with the proxy
val bio = auth.proxy("getBio").await() // call a method on the server proxy
```

Calls on `.proxy(...)` are queued and sent immediately; the server matches them to
the stateful object created for that request.

### Cleanup

`ResultHandle.cancel()` releases server-side subscriptions and stops further updates.
Closing the `LowlanderConnection` drops all in-flight requests.

## How fine-grained reactivity works

The streamed tree is materialized as nested `SnapshotStateMap` / `SnapshotStateList`.
Compose tracks reads of those structures, so when the server pushes a delta that
mutates a single leaf, only composables that read *that* leaf recompose. Linked-model
references are deduplicated by hash — if Person A and Person B both reference Group G,
they share the same `SnapshotStateMap` and a change to G's name updates both views.

## Limitations

- No type checking — server method names, argument shapes and return shapes are
  opaque to Kotlin. Consider sharing a hand-written API descriptor between server
  and client.
- Server-side stream `cache` window is honored by the server; the Android client
  does not currently deduplicate identical requests on its own.
- `DataPack` `Set`s, JS `Map`s and `Date`s round-trip as `LinkedHashSet`,
  `DataPack.TaggedMap`, and `java.util.Date` respectively when present in payloads.

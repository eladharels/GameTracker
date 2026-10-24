package ink.etech.gametracker

/**
 * The backlog's order, as one list (MOB-14). Pure, so the rules run in JVM tests.
 *
 * A drag used to send one `PUT …/backlog-order {direction}` per step moved, never checking an
 * answer, so a failure part-way left the backlog half-moved and nothing said so. It now sends
 * the WHOLE order in one `PUT …/backlog-reorder`, which the server applies in one transaction.
 */
object BacklogOrder {
    private fun idOf(g: Game): String? = g.game_id ?: g.id

    /** The backlog games of [library], in their stored order (unknown positions last). */
    fun backlog(library: List<Game>): List<Game> =
        library.filter { GameStatus.canonical(it.status) == GameStatus.BACKLOG }
            .sortedBy { it.backlog_order ?: Int.MAX_VALUE }

    /**
     * Each backlog game's position, 1-based, in the WHOLE backlog. Cards show this, never the
     * stored `backlog_order`: once the stored numbers have gaps they disagree with Home, which
     * shows the list position (the web's FE-24). A search-filtered list still shows a game's
     * real position.
     */
    fun positions(library: List<Game>): Map<String, Int> =
        backlog(library).mapIndexedNotNull { i, g -> idOf(g)?.let { it to i + 1 } }.toMap()

    /** The body for `backlog-reorder`: every backlog game's id, in [ordered]'s order. */
    fun request(ordered: List<Game>): BacklogReorderRequest =
        BacklogReorderRequest(ordered.mapNotNull { idOf(it) })

    /**
     * Whether a drag may start. Not while a search narrows the list: "two down" among the
     * games that match is a different move in the real backlog (MOB-14).
     */
    fun canDrag(filter: String, searchQuery: String): Boolean = filter == GameStatus.BACKLOG && searchQuery.isBlank()
}

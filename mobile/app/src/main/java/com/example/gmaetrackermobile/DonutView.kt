package com.example.gmaetrackermobile

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.min

/**
 * Simple completion donut used on the Insights tab.
 * Set the fraction (0f..1f) via [setProgress]; draws a track ring, an accent progress
 * arc, and a centered percentage label — matching the prototype's SVG donut.
 */
class DonutView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyle: Int = 0
) : View(context, attrs, defStyle) {

    private var progress = 0f
    private val density = resources.displayMetrics.density

    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#14FFFFFF")
        strokeWidth = 13f * density
    }
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#22C55E")
        strokeWidth = 13f * density
        strokeCap = Paint.Cap.ROUND
    }
    private val pctPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#F0F1F8")
        textAlign = Paint.Align.CENTER
        textSize = 24f * density
        isFakeBoldText = true
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#8890A8")
        textAlign = Paint.Align.CENTER
        textSize = 10f * density
    }
    private val oval = RectF()

    fun setProgress(fraction: Float) {
        progress = fraction.coerceIn(0f, 1f)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val pad = 8f * density
        val size = min(width, height).toFloat()
        oval.set(pad, pad, size - pad, size - pad)
        canvas.drawArc(oval, 0f, 360f, false, trackPaint)
        canvas.drawArc(oval, -90f, 360f * progress, false, arcPaint)

        val cx = size / 2f
        val cy = size / 2f
        canvas.drawText("${(progress * 100).toInt()}%", cx, cy + (4f * density), pctPaint)
        canvas.drawText("complete", cx, cy + (20f * density), labelPaint)
    }
}

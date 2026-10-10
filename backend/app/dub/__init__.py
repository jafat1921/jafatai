"""Dub a video (contract v18): a resumable pipeline of stage jobs over one DubProject row.

project  -> the row's JSON (segments, speakers, stages), edits, split / merge, queueing
stages   -> the ten stage functions, the dub_stage and dub_export job handlers
text     -> translation, the shorter-line ask and the word error rate
engines  -> the GPU-box runners (separation, speaker embeddings, batched speech, batched Whisper)
export   -> the multi-language MP4
"""

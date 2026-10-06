"""Offline keyword-only PCM worker. No microphone, files of audio, or network."""
import json
import struct
import sys
from pathlib import Path
import numpy as np
import sentencepiece as spm
import sherpa_onnx

directory = Path(sys.argv[1])
model = directory / 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
tokenizer = spm.SentencePieceProcessor(model_file=str(model / 'bpe.model'))
keywords = ' '.join(tokenizer.encode('FREYA', out_type=str)) + ' :2.0 #0.25 @Freya'
keyword_file = directory / 'keywords.txt'
keyword_file.write_text(keywords + '\n', encoding='utf-8')
spotter = sherpa_onnx.KeywordSpotter(
    tokens=str(model / 'tokens.txt'),
    encoder=str(model / 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    decoder=str(model / 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
    joiner=str(model / 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    num_threads=1, provider='cpu', keywords_file=str(keyword_file),
)
stream = spotter.create_stream()
print(json.dumps({'ready': True}), flush=True)

def read_exact(size):
    data = bytearray()
    while len(data) < size:
        part = sys.stdin.buffer.read(size - len(data))
        if not part:
            return None
        data.extend(part)
    return data

while True:
    header = read_exact(4)
    if header is None:
        break
    size = struct.unpack('<I', header)[0]
    if size == 0:
        stream = spotter.create_stream()
        continue
    if size > 8192 or size % 2:
        break
    pcm = read_exact(size)
    if pcm is None:
        break
    stream.accept_waveform(16000, np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0)
    while spotter.is_ready(stream):
        spotter.decode_stream(stream)
        if spotter.get_result(stream):
            spotter.reset_stream(stream)
            print(json.dumps({'wake': True}), flush=True)

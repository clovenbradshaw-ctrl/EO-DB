"""
EO Embedding Classification System — Phase 1
Centroid Generation (offline, Python)

Inputs:
  data/exemplars.json
Outputs:
  centroids.json
  alignment_matrix.json
  centroid_stats.json

Runtime: ~15-30 min CPU, ~3-5 min GPU

Dependencies:
  pip install sentence-transformers numpy scipy torch
"""

import json
import numpy as np
from scipy.linalg import orthogonal_procrustes
from sentence_transformers import SentenceTransformer

MULTILINGUAL_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'
SMALL_MODEL        = 'all-MiniLM-L6-v2'
TOP_N              = 100
MIN_MARGIN         = 0.03
ALIGNMENT_N        = 500
BATCH_SIZE         = 64

with open('data/exemplars.json') as f:
    data = json.load(f)
cells = data['27cell']

# Select top-N consensus exemplars per cell
selected = {}
all_english = []
for cell_key, exemplars in cells.items():
    ranked = sorted(exemplars, key=lambda x: x.get('margin', 0), reverse=True)
    top = [e for e in ranked if e.get('margin', 0) >= MIN_MARGIN][:TOP_N]
    if not top:
        top = ranked[:min(10, len(ranked))]
    selected[cell_key] = [e['text'] for e in top]
    all_english.extend([e['text'] for e in top if e.get('lang') == 'en'])
    print(f"  {cell_key}: {len(top)} exemplars")

# Embed with multilingual model
ml_model = SentenceTransformer(MULTILINGUAL_MODEL)
centroids = {}
centroid_stats = {}

for cell_key, texts in selected.items():
    embeddings = ml_model.encode(
        texts, batch_size=BATCH_SIZE, normalize_embeddings=True
    )
    centroid = embeddings.mean(axis=0)
    centroid /= np.linalg.norm(centroid)
    intra_variance = float(np.mean([1 - float(np.dot(e, centroid)) for e in embeddings]))
    centroids[cell_key] = centroid.tolist()
    centroid_stats[cell_key] = {
        'exemplar_count': len(texts),
        'mean_margin': float(np.mean([
            e.get('margin', 0) for e in sorted(
                cells[cell_key], key=lambda x: x.get('margin', 0), reverse=True
            )[:TOP_N]
        ])),
        'intra_variance': intra_variance
    }

OP_MAP = {
    'NUL': {'mode': 'Differentiating', 'domain': 'Existence'},
    'SIG': {'mode': 'Relating',        'domain': 'Existence'},
    'INS': {'mode': 'Generating',      'domain': 'Existence'},
    'SEG': {'mode': 'Differentiating', 'domain': 'Structure'},
    'CON': {'mode': 'Relating',        'domain': 'Structure'},
    'SYN': {'mode': 'Generating',      'domain': 'Structure'},
    'EVA': {'mode': 'Differentiating', 'domain': 'Significance'},
    'DEF': {'mode': 'Relating',        'domain': 'Significance'},
    'REC': {'mode': 'Generating',      'domain': 'Significance'},
}

centroid_records = []
for cell_key, vector in centroids.items():
    op = cell_key.split('(')[0]
    inner = cell_key[len(op)+1:-1]
    parts = [p.strip() for p in inner.split(',')]
    cell_id = cell_key.replace('(', '_').replace(')', '').replace(', ', '_').replace(' ', '_')
    centroid_records.append({
        'cell_id':    cell_id,
        'cell_key':   cell_key,
        'operator':   op,
        'resolution': parts[0] if parts else '',
        'site':       parts[1] if len(parts) > 1 else '',
        **OP_MAP.get(op, {}),
        'vector':     vector,
        **centroid_stats[cell_key]
    })

with open('centroids.json', 'w') as f:
    json.dump(centroid_records, f)
print(f"Wrote centroids.json ({len(centroid_records)} cells)")

# Procrustes alignment: multilingual → small model
alignment_texts = all_english[:ALIGNMENT_N]
small_model = SentenceTransformer(SMALL_MODEL)
ml_align = ml_model.encode(alignment_texts,  normalize_embeddings=True)
sm_align = small_model.encode(alignment_texts, normalize_embeddings=True)
R, scale = orthogonal_procrustes(sm_align, ml_align)
residual = float(np.mean(np.linalg.norm(sm_align @ R - ml_align, axis=1)))
print(f"Alignment residual: {residual:.4f}")

with open('alignment_matrix.json', 'w') as f:
    json.dump({'R': R.tolist(), 'scale': float(scale), 'residual': residual,
               'n': len(alignment_texts), 'multilingual_model': MULTILINGUAL_MODEL,
               'small_model': SMALL_MODEL}, f)

# Validation
vectors = np.array([r['vector'] for r in centroid_records])
intra, inter = [], []
for i, r1 in enumerate(centroid_records):
    for j, r2 in enumerate(centroid_records):
        sim = float(np.dot(r1['vector'], r2['vector']))
        if r1['operator'] == r2['operator'] and i != j: intra.append(sim)
        elif r1['operator'] != r2['operator']:           inter.append(sim)

print(f"Intra-operator centroid similarity: {np.mean(intra):.3f}")
print(f"Inter-operator centroid similarity: {np.mean(inter):.3f}")
print(f"Separation: {np.mean(intra) - np.mean(inter):.3f} (positive = good)")

with open('centroid_stats.json', 'w') as f:
    json.dump({'stats': centroid_stats, 'mean_intra': float(np.mean(intra)),
               'mean_inter': float(np.mean(inter)),
               'separation': float(np.mean(intra) - np.mean(inter))}, f, indent=2)

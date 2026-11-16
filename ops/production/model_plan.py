"""Exact runtime dependencies; public downloads never bypass gated access."""
QWEN_REPO='Comfy-Org/Qwen-Image_ComfyUI'
QWEN_FILES=[
    'split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors',
    'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
    'split_files/vae/qwen_image_vae.safetensors',
]
PUBLIC=[
    ('microsoft/TRELLIS.2-4B',None),
    ('microsoft/TRELLIS-image-large',['ckpts/ss_dec_conv3d_16l8_fp16.json','ckpts/ss_dec_conv3d_16l8_fp16.safetensors']),
    (QWEN_REPO,QWEN_FILES),
    ('ZhengPeng7/BiRefNet',['*.json','*.py','model.safetensors']),
]
GATED=['facebook/dinov3-vitl16-pretrain-lvd1689m','briaai/RMBG-2.0']

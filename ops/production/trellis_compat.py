"""Preserve TRELLIS conditioning across the DINOv3 Transformers module layout change."""
from types import MethodType


def configure_feature_extractor(extractor):
    model=extractor.model
    if hasattr(model,'layer'):return False
    encoder=getattr(model,'model',None)
    if encoder is None or not hasattr(encoder,'layer'):
        raise RuntimeError('Unsupported DINOv3 module layout; cannot extract TRELLIS conditioning')

    def extract_features(self,image):
        import torch.nn.functional as F
        image=image.to(self.model.embeddings.patch_embeddings.weight.dtype)
        hidden=self.model.embeddings(image,bool_masked_pos=None)
        positions=self.model.rope_embeddings(image)
        for layer in self.model.model.layer:
            hidden=layer(hidden,position_embeddings=positions)
        # Match the upstream TRELLIS extractor, before DINO's learned final norm.
        return F.layer_norm(hidden,hidden.shape[-1:])

    extractor.extract_features=MethodType(extract_features,extractor)
    return True

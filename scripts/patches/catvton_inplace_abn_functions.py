# Replaces ComfyUI-CatVTON's model/SCHP/modules/functions.py (installed by Mix AI's install-image-tools.sh).
#
# The original JIT-compiles an "inplace_abn" CUDA extension when it is imported, which needs the CUDA toolkit
# (nvcc, CUDA_HOME). Without it the whole node pack fails to load. CatVTON only runs SCHP for inference, where
# in-place activated batch norm is plain batch norm followed by the activation, so PyTorch does it as well.
import torch.nn.functional as F

ACT_RELU = "relu"
ACT_LEAKY_RELU = "leaky_relu"
ACT_ELU = "elu"
ACT_NONE = "none"


def _abn(x, weight, bias, running_mean, running_var, training=True, momentum=0.1, eps=1e-05,
         activation=ACT_LEAKY_RELU, slope=0.01):
    x = F.batch_norm(x, running_mean, running_var, weight, bias, training, momentum, eps)
    if activation == ACT_LEAKY_RELU:
        x = F.leaky_relu(x, slope)
    elif activation == ACT_RELU:
        x = F.relu(x)
    elif activation == ACT_ELU:
        x = F.elu(x)
    # same shape as the extension's result: (output, running_mean, running_var)
    return x, running_mean, running_var


inplace_abn = _abn
inplace_abn_sync = _abn

__all__ = ["inplace_abn", "inplace_abn_sync", "ACT_RELU", "ACT_LEAKY_RELU", "ACT_ELU", "ACT_NONE"]

# Turing OS Helm Chart for Kubernetes

## Prerequisites

- Kubernetes 1.24+
- Helm 3.7+
- Default StorageClass for PVCs

## Quick Install

```bash
# Add helm repo
helm repo add turing-os https://charts.turing-os.ai
helm repo update

# Install
helm install turing turing-os/turing-os \
  --namespace turing-system --create-namespace \
  --set credentials.llmApiKey=$LLM_API_KEY \
  --set credentials.adminPassword=$ADMIN_PASSWORD
```

## Configuration

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `credentials.llmApiKey` | Yes | - | LLM API key |
| `credentials.adminPassword` | No | auto-generated | Admin password for all services |
| `credentials.llmProvider` | No | openai-compat | LLM provider |
| `credentials.defaultModel` | No | gpt-4o | Default model |
| `credentials.llmBaseUrl` | No | https://api.openai.com/v1 | OpenAI-compatible base URL |
| `gateway.publicURL` | Yes | http://localhost:18080 | Public URL for access |
| `global.imageRegistry` | No | docker.io | Image registry |

## Values.yaml

```yaml
# Default values for Turing OS

namespace: turing-system

# Credentials
credentials:
  llmApiKey: ""
  adminPassword: ""
  llmProvider: "openai-compat"
  defaultModel: "gpt-4o"
  llmBaseUrl: "https://api.openai.com/v1"

# Gateway
gateway:
  publicURL: "http://localhost:18080"
  replicas: 2

# Image settings
global:
  imageRegistry: "docker.io"

# Services
services:
  taiga:
    enabled: true
    replicas: 1
    storageSize: 10Gi
    
  wiki:
    enabled: true
    replicas: 1
    storageSize: 5Gi
    
  matrix:
    enabled: true
    replicas: 1
    
  orchestrator:
    enabled: true
    replicas: 1

# Worker configuration
worker:
  defaultRuntime: "hermes"
  maxWorkers: 5
  resourceMode: "conservative"

# Resource limits
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 2000m
    memory: 2Gi
```

## Multi-Region Registry

For faster image pulls:

```bash
# China
--set global.imageRegistry=higress-registry.cn-hangzhou.cr.aliyuncs.com/higress

# North America
--set global.imageRegistry=higress-registry.us-west-1.cr.aliyuncs.com/higress

# Southeast Asia
--set global.imageRegistry=higress-registry.ap-southeast-7.cr.aliyuncs.com/higress
```

## Access After Install

```bash
# Port forward to access
kubectl port-forward -n turing-system svc/turing-gateway 18080:80

# Open in browser
# http://localhost:18080
```

## Upgrading

```bash
helm repo update
helm upgrade turing turing-os/turing-os -n turing-system --reuse-values
```

## Uninstall

```bash
helm uninstall turing -n turing-system
kubectl delete namespace turing-system
```
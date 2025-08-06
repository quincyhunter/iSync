# iSync Music Manager - Complete Project Brief

## Executive Summary

iSync Music Manager is an open-source, serverless platform that enables users to upload music files from any device to their Apple Music library through an automated cloud pipeline. The project demonstrates enterprise-grade architecture using AWS services within free-tier limits, making it accessible for anyone to self-host.

## Project Objectives

### Primary Goals
1. Create a production-ready system for uploading music to Apple Music without desktop iTunes
2. Demonstrate mastery of AWS cloud services and serverless architecture
3. Build a portfolio project that showcases enterprise software engineering practices
4. Provide a fully open-source solution with comprehensive documentation

### Technical Requirements
- **Cost**: $0 using AWS free tier and free hosting services
- **Scalability**: Handle 1-10,000 uploads per month
- **Reliability**: 99.9% upload success rate with automatic retry logic
- **Security**: Enterprise-grade security with encrypted storage and secure credentials
- **Performance**: Process uploads within 5 minutes during active periods

## Technology Stack

### Cloud Infrastructure (AWS)
- **Compute**: Lambda (Node.js 18.x), EC2 t2.micro (Ubuntu 22.04)
- **Storage**: S3 (music files), DynamoDB (metadata)
- **Messaging**: SQS (job queue), EventBridge (scheduling)
- **API**: API Gateway REST API
- **Security**: IAM, Secrets Manager, KMS
- **Monitoring**: CloudWatch, X-Ray
- **IaC**: Terraform 1.5+

### Application Stack
- **Frontend**: Next.js 14 (App Router), TypeScript, Tailwind CSS, PWA
- **Backend**: Node.js, TypeScript, AWS SDK v3
- **Automation**: Python 3.11, AppleScript/PowerShell
- **Containerization**: Docker, Docker Compose
- **CI/CD**: GitHub Actions
- **Testing**: Jest, Cypress, pytest

## System Architecture

### High-Level Flow
```
User Device → Next.js PWA → API Gateway → Lambda → SQS → EC2 (on-demand) → iTunes → iCloud
                                         ↓         ↓
                                        S3    DynamoDB
```

### Detailed Component Architecture

#### 1. Frontend Layer (Next.js PWA)
- **Hosting**: Vercel (free tier)
- **Features**:
  - Drag-and-drop file upload with progress tracking
  - Automatic metadata extraction from ID3 tags
  - Real-time status updates via polling/websockets
  - Offline support with service workers
  - Installable PWA for mobile/desktop

#### 2. API Layer (API Gateway + Lambda)
- **Endpoints**:
  - `POST /upload` - Initiate file upload
  - `GET /upload/{id}` - Check upload status
  - `GET /library` - List user's uploads
  - `POST /auth` - User authentication
  - `DELETE /upload/{id}` - Cancel upload

#### 3. Processing Layer
- **Lambda Functions**:
  - `uploadHandler` - Validates and stores files to S3
  - `metadataProcessor` - Extracts and validates metadata
  - `queueManager` - Manages SQS queue
  - `ec2Controller` - Triggers EC2 instances
  - `statusUpdater` - Updates DynamoDB status

#### 4. Storage Layer
- **S3 Structure**:
  ```
  isync-music-{accountId}/
  ├── uploads/{userId}/{uploadId}/
  │   ├── audio.{mp3|m4a|flac}
  │   ├── metadata.json
  │   └── artwork.jpg
  ├── processed/
  └── failed/
  ```

- **DynamoDB Schema**:
  ```typescript
  // UploadQueue Table
  {
    PK: uploadId (String)
    SK: userId (String)
    GSI1PK: userId (String)
    GSI1SK: createdAt (Number)
    status: 'pending' | 'processing' | 'completed' | 'failed'
    metadata: {
      title: String
      artist: String
      album: String
      genre: String
      year: Number
      duration: Number
      fileSize: Number
    }
    s3Key: String
    attempts: Number
    error: String?
    createdAt: Number
    updatedAt: Number
    completedAt: Number?
  }
  ```

#### 5. Processing Engine (EC2)
- **Trigger Conditions**:
  - Queue depth ≥ 10 items
  - Scheduled every 6 hours
  - Manual trigger via API
- **Automation**:
  - Python orchestrator
  - AppleScript (macOS) / PowerShell (Windows)
  - iTunes COM interface

## Code Quality Standards

### TypeScript/JavaScript
```typescript
// Follow Airbnb style guide with modifications
// Example: uploadHandler.ts

import { APIGatewayProxyHandler } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

/**
 * Schema for upload request validation
 */
const UploadRequestSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().min(1).max(100_000_000), // 100MB max
  contentType: z.enum(['audio/mpeg', 'audio/mp4', 'audio/flac']),
  metadata: z.object({
    title: z.string().min(1).max(200),
    artist: z.string().min(1).max(200),
    album: z.string().optional(),
    year: z.number().min(1900).max(2100).optional(),
  }),
});

/**
 * Handles music file upload initiation
 * @param event - API Gateway event
 * @returns Presigned URL for S3 upload
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  // Implementation with comprehensive error handling
};
```

### Python
```python
"""
EC2 Music Processor
Orchestrates the processing of queued music uploads to iTunes/Apple Music
"""

from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from datetime import datetime
import logging
from pathlib import Path

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

@dataclass
class MusicFile:
    """Represents a music file to be processed"""
    upload_id: str
    user_id: str
    s3_key: str
    metadata: Dict[str, Any]
    created_at: datetime
    
class MusicProcessor:
    """
    Processes music files from SQS queue and adds them to iTunes library
    
    Attributes:
        s3_client: AWS S3 client
        sqs_client: AWS SQS client
        dynamodb: DynamoDB resource
    """
    
    def __init__(self, region: str = 'us-east-1'):
        self.s3_client = boto3.client('s3', region_name=region)
        self.sqs_client = boto3.client('sqs', region_name=region)
        self.dynamodb = boto3.resource('dynamodb', region_name=region)
```

### Documentation Standards

Every module must include:
1. **README.md** with setup instructions
2. **API documentation** (OpenAPI/Swagger)
3. **Architecture Decision Records** (ADRs)
4. **Inline code comments** for complex logic
5. **JSDoc/docstrings** for all public functions

## Project Structure

```
isync-music-manager/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── deploy-backend.yml
│   │   └── deploy-frontend.yml
│   └── ISSUE_TEMPLATE/
├── frontend/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── upload/
│   │   ├── library/
│   │   └── api/
│   ├── components/
│   ├── lib/
│   ├── public/
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md
├── backend/
│   ├── lambdas/
│   │   ├── upload-handler/
│   │   ├── metadata-processor/
│   │   ├── queue-manager/
│   │   ├── ec2-controller/
│   │   └── shared/
│   ├── scripts/
│   │   ├── deploy.sh
│   │   └── test.sh
│   ├── package.json
│   └── tsconfig.json
├── processor/
│   ├── src/
│   │   ├── processor.py
│   │   ├── automation/
│   │   │   ├── __init__.py
│   │   │   ├── apple_music.py
│   │   │   └── itunes_controller.py
│   │   └── utils/
│   ├── tests/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── README.md
├── infrastructure/
│   ├── terraform/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── modules/
│   ├── scripts/
│   └── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API.md
│   ├── SETUP.md
│   ├── TROUBLESHOOTING.md
│   └── adr/
│       ├── 001-serverless-architecture.md
│       └── 002-processing-strategy.md
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── load/
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

## Development Workflow

### Git Strategy
- **Main branch**: Production-ready code
- **Develop branch**: Integration branch
- **Feature branches**: `feature/add-upload-progress`
- **Commit convention**: Conventional Commits
  ```
  feat(upload): add progress tracking for large files
  fix(auth): resolve token expiration issue
  docs(api): update endpoint documentation
  ```

### Version Control Best Practices
```bash
# .gitignore essentials
.env
.env.local
*.pem
node_modules/
dist/
.terraform/
*.tfstate
__pycache__/
.pytest_cache/
.coverage
```

### Testing Strategy

#### Unit Tests (Jest/pytest)
- Minimum 80% code coverage
- Test all business logic
- Mock AWS services

#### Integration Tests
- Test Lambda functions with local AWS services (LocalStack)
- Validate API endpoints
- Test database operations

#### E2E Tests (Cypress)
- User upload flow
- Authentication flow
- Error handling scenarios

### CI/CD Pipeline

```yaml
# GitHub Actions workflow example
name: CI/CD Pipeline

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x]
        python-version: [3.11]
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
      
      - name: Setup Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ matrix.python-version }}
      
      - name: Install dependencies
        run: |
          npm ci --prefix frontend
          npm ci --prefix backend
          pip install -r processor/requirements.txt
      
      - name: Run linters
        run: |
          npm run lint --prefix frontend
          npm run lint --prefix backend
          pylint processor/src
      
      - name: Run tests
        run: |
          npm test --prefix frontend -- --coverage
          npm test --prefix backend -- --coverage
          pytest processor/tests --cov=processor/src
      
      - name: SonarCloud Scan
        uses: SonarSource/sonarcloud-github-action@master
```

## Security Implementation

### Authentication & Authorization
- JWT tokens with refresh mechanism
- AWS IAM roles for service-to-service auth
- API key rate limiting

### Data Protection
- AES-256 encryption at rest (S3, DynamoDB)
- TLS 1.3 for data in transit
- Sensitive data in AWS Secrets Manager

### Security Headers
```typescript
// Next.js security headers
const securityHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on'
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload'
  },
  {
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN'
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff'
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin'
  }
];
```

## Performance Optimization

### Frontend
- Lazy loading for routes
- Image optimization with next/image
- Service worker for offline support
- Bundle size < 200KB initial load

### Backend
- Lambda cold start optimization
- Connection pooling for database
- S3 Transfer Acceleration for large files
- SQS batch processing

### Monitoring Metrics
- P99 latency < 1s for API calls
- Upload success rate > 99.9%
- EC2 utilization > 70% when running
- Cost per upload < $0.001

## Change Log Format

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Feature descriptions

### Changed
- Modification descriptions

### Fixed
- Bug fix descriptions

### Security
- Security fix descriptions

## [1.0.0] - 2024-12-XX

### Added
- Initial release with core upload functionality
- AWS Lambda processing pipeline
- Next.js PWA frontend
- Terraform infrastructure as code
```

## Error Handling Strategy

### Lambda Error Handling
```typescript
export class UploadError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

// Standardized error responses
export const errorHandler = (error: unknown) => {
  if (error instanceof UploadError) {
    return {
      statusCode: error.statusCode,
      body: JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable
        }
      })
    };
  }
  // Generic error handling
};
```

### Retry Logic
- Exponential backoff for transient failures
- Dead letter queue for permanent failures
- Maximum 3 retry attempts
- Alert on repeated failures

## Deployment Strategy

### Environments
1. **Development**: Local development with LocalStack
2. **Staging**: AWS account with limited resources
3. **Production**: Full AWS deployment with monitoring

### Infrastructure as Code
```hcl
# terraform/main.tf excerpt
terraform {
  backend "s3" {
    bucket = "isync-terraform-state"
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
    encrypt = true
  }
}

module "lambda_functions" {
  source = "./modules/lambda"
  
  environment = var.environment
  
  functions = {
    upload_handler = {
      runtime = "nodejs18.x"
      memory  = 512
      timeout = 30
    }
    metadata_processor = {
      runtime = "nodejs18.x"
      memory  = 256
      timeout = 10
    }
  }
}
```

## Success Metrics

### Technical Metrics
- **Deployment frequency**: Daily
- **Lead time for changes**: < 1 hour
- **Mean time to recovery**: < 30 minutes
- **Change failure rate**: < 5%

### Business Metrics
- **User adoption**: 100+ GitHub stars in first month
- **Documentation quality**: 100% API coverage
- **Community engagement**: Active discussions and PRs

## Open Source Strategy

### Documentation
- Comprehensive README with quick start
- Video tutorials for setup
- Architecture diagrams
- API documentation with examples

### Community
- GitHub Discussions for Q&A
- Contributing guidelines
- Code of Conduct
- Issue and PR templates

### Licensing
- MIT License for maximum adoption
- Clear attribution requirements
- CLA for contributors

## Important Constraints & Considerations

### AWS Free Tier Limits
- Lambda: 1M requests, 400,000 GB-seconds
- S3: 5GB storage, 20,000 GET, 2,000 PUT
- DynamoDB: 25GB storage, 25 RCU/WCU
- EC2: 750 hours t2.micro
- API Gateway: 1M calls (12 months)

### iTunes/Apple Music Integration
- Requires desktop iTunes or Music app
- Must handle Windows/macOS differences
- Apple ID credentials must be secured
- Rate limiting considerations

### Scalability Considerations
- Design for 1-10,000 users
- Optimize for batch processing
- Consider multi-region deployment
- Plan for graceful degradation

## Development Timeline

### Phase 1: Foundation (Week 1-2)
- [ ] AWS account setup
- [ ] Basic Terraform configuration
- [ ] Initial Lambda functions
- [ ] S3 and DynamoDB setup
- [ ] GitHub repository setup

### Phase 2: Core Backend (Week 3-4)
- [ ] Complete Lambda functions
- [ ] SQS integration
- [ ] EC2 automation scripts
- [ ] API Gateway configuration
- [ ] Error handling

### Phase 3: Frontend (Week 5-6)
- [ ] Next.js setup with TypeScript
- [ ] Upload interface
- [ ] Status tracking
- [ ] PWA configuration
- [ ] Authentication

### Phase 4: Integration (Week 7)
- [ ] iTunes automation
- [ ] End-to-end testing
- [ ] Performance optimization
- [ ] Security audit

### Phase 5: Documentation & Release (Week 8)
- [ ] Complete documentation
- [ ] Video tutorials
- [ ] Docker setup
- [ ] GitHub release
- [ ] Marketing materials

## Key Design Decisions

### ADR-001: Serverless Architecture
**Status**: Accepted  
**Context**: Need to minimize costs while maintaining scalability  
**Decision**: Use Lambda for all processing except iTunes interaction  
**Consequences**: Lower costs, higher complexity, vendor lock-in  

### ADR-002: Processing Strategy
**Status**: Accepted  
**Context**: iTunes requires desktop application  
**Decision**: Use on-demand EC2 instances with batch processing  
**Consequences**: Delayed processing, complex orchestration, cost savings  

### ADR-003: Frontend Framework
**Status**: Accepted  
**Context**: Need modern, performant frontend  
**Decision**: Next.js with App Router and TypeScript  
**Consequences**: Better SEO, type safety, larger bundle size  

## Final Notes for Claude Code

When implementing this project:

1. **Always prioritize code quality over speed** - This is a portfolio project
2. **Write comprehensive tests** - Aim for 80%+ coverage
3. **Document everything** - Every function, every decision
4. **Follow AWS best practices** - Use IAM roles, not keys
5. **Implement proper error handling** - Never let errors go silent
6. **Use TypeScript strictly** - No `any` types unless absolutely necessary
7. **Keep functions small** - Single responsibility principle
8. **Make it production-ready** - This should be deployable to real users
9. **Consider costs** - Always optimize for free tier limits
10. **Build for the community** - Make it easy for others to use and contribute

Remember: This project should demonstrate that you can build production-grade software, not just prototypes. Every line of code should be something you'd be proud to show in a technical interview.
### iSync
Upload a music file from your phone and have it appear in your Apple Music/iCloud library. Event driven backend on AWS; small React Native (Expo) mobile uploader that writes ID3 tags on device, starts a Windows VM only when needed, and uploads via presigned S3.

### Architecture at a glance
- API Gateway → Lambda (TypeScript): `upload-handler`, `metadata-processor`, `queue-manager`, `ec2-controller`
- S3 for uploads, DynamoDB for status, SQS for processing jobs
- EC2 Auto Scaling Group (Windows Server) runs iTunes automation; scales from 0 based on queue depth
- React Native (Expo) app performs local ID3 tagging and PUTs to presigned S3 URL

### Prerequisites
- AWS account with permissions for API Gateway, Lambda, S3, DynamoDB, SQS, EC2, IAM
- AWS CLI installed and configured (`aws configure`)
- Terraform >= 1.5 (`terraform -version`)
- Node 20+ and npm (`node -v`, `npm -v`)
- Optional (mobile build on CI): macOS/GitHub Actions to produce unsigned IPA, or run locally with Expo Dev Client
- A Windows Server 2022 AMI you create that has iTunes + Python + iSync processor installed (you will use its `ami-xxxxxxxx`)

### Step-by-step setup
1) Build backend deployment zips
```bash
cd backend
npm ci
npx ts-node scripts/build.ts
```

2) Deploy infrastructure with your AMI
```bash
cd ../infrastructure/terraform
terraform init
terraform apply -var "environment=prod" -var "aws_region=us-east-1" -var "ec2_ami_id=ami-xxxxxxxx"
```

3) Get your API endpoint
```bash
terraform output -raw api_endpoint
```

4) Configure the mobile app to point at your API
```bash
# Example
set EXPO_PUBLIC_API_BASE=https://<your-api-id>.execute-api.us-east-1.amazonaws.com/prod   # Windows PowerShell: $env:EXPO_PUBLIC_API_BASE="..."
```
Run the app with Expo Dev Client or use the provided GitHub Action (`.github/workflows/ios-ipa.yml`) to build an unsigned IPA and sideload with AltStore/Sideloadly.

5) Optional: Prepare your Windows AMI (one-time)
- Launch a Windows Server 2022 instance, RDP in, install iTunes, Python 3.11, AWS CLI
- Copy `processor/` to `C:\\iSync\\processor`, install requirements, and test `src/main.py`
- Create an AMI from the configured instance and use its `ami-xxxxxxxx` when applying Terraform

### Repository layout (kept minimal and professional)
- `backend/`: TypeScript Lambdas + build script (no `dist/` committed)
- `infrastructure/terraform/`: all Terraform modules and `.terraform.lock.hcl` (no state/plan files)
- `isync-mobile/`: Expo/React Native app (no `node_modules/`, `ios/`, `android/`)
- `processor/`: Python processor source + tests (no virtualenv, no zipped artifacts)

### Variables you provide
- Terraform: `ec2_ami_id` (your Windows AMI with iTunes/processor), `aws_region`, optional `environment`
- Mobile: `EXPO_PUBLIC_API_BASE` (outputs from `terraform output -raw api_endpoint`)


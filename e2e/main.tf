# Sample configuration for the end-to-end workflow (.github/workflows/e2e.yml).
# `terraform plan -refresh=false` with dummy credentials: nothing is created and AWS is not called.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region                      = "ap-northeast-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "dummy"
  secret_key                  = "dummy"
}

resource "aws_instance" "web" {
  ami           = "ami-0123456789abcdef0"
  instance_type = "m5.large"
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
  }
}

resource "aws_db_instance" "db" {
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  allocated_storage   = 20
  username            = "app"
  password            = "dummy-password-123"
  skip_final_snapshot = true
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier  = "app"
  engine              = "aurora-postgresql"
  storage_type        = "aurora-iopt1"
  master_username     = "app"
  master_password     = "dummy-password-123"
  skip_final_snapshot = true
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "app-writer"
  cluster_identifier = aws_rds_cluster.aurora.id
  engine             = aws_rds_cluster.aurora.engine
  instance_class     = "db.r7g.large"
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id = "app-cache"
  description          = "app cache"
  engine               = "valkey"
  node_type            = "cache.r7g.large"
  num_cache_clusters   = 2
}

resource "aws_nat_gateway" "main" {
  subnet_id     = "subnet-0123456789abcdef0"
  allocation_id = "eipalloc-0123456789abcdef0"
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_s3_bucket" "logs" {
  bucket = "example-logs-bucket-0123456789"
}

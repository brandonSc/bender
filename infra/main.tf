terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ---------------------------------------------------------------------------- #
#                                 Data Sources                                  #
# ---------------------------------------------------------------------------- #

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ---------------------------------------------------------------------------- #
#                               Security Group                                  #
# ---------------------------------------------------------------------------- #

resource "aws_security_group" "bender" {
  name        = "bender"
  description = "Bender agent - webhooks (443), ACME (80), SSH (22)"

  # HTTPS - webhook ingress
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTP - Let's Encrypt ACME challenges + redirect
  ingress {
    description = "HTTP (ACME)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_allow_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "bender"
  }
}

# ---------------------------------------------------------------------------- #
#                                EC2 Instance                                   #
# ---------------------------------------------------------------------------- #

resource "aws_instance" "bender" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [aws_security_group.bender.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    domain = var.domain
  })

  root_block_device {
    volume_size           = var.disk_size
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tags = {
    Name = "bender"
  }
}

# ---------------------------------------------------------------------------- #
#                                Elastic IP                                     #
# ---------------------------------------------------------------------------- #

resource "aws_eip" "bender" {
  instance = aws_instance.bender.id

  tags = {
    Name = "bender"
  }
}

# ---------------------------------------------------------------------------- #
#                                 DNS Record                                    #
# ---------------------------------------------------------------------------- #

resource "aws_route53_record" "bender" {
  zone_id = var.route53_zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.bender.public_ip]
}

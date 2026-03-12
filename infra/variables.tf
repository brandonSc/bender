variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.large"
}

variable "disk_size" {
  description = "Root volume size in GB"
  type        = number
  default     = 80
}

variable "key_name" {
  description = "Name of an existing EC2 key pair for SSH access"
  type        = string
}

variable "domain" {
  description = "FQDN for the server (e.g. bender.demo.earthly.dev)"
  type        = string
}

variable "route53_zone_id" {
  description = "Route53 hosted zone ID for the domain"
  type        = string
}

variable "ssh_allow_cidrs" {
  description = "CIDR blocks allowed to SSH (port 22)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

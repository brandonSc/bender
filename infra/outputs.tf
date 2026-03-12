output "public_ip" {
  description = "Elastic IP address"
  value       = aws_eip.bender.public_ip
}

output "domain" {
  description = "FQDN of the server"
  value       = var.domain
}

output "webhook_url_github" {
  description = "GitHub App webhook URL"
  value       = "https://${var.domain}/webhooks/github"
}

output "webhook_url_linear" {
  description = "Linear webhook URL"
  value       = "https://${var.domain}/webhooks/linear"
}

output "ssh_command" {
  description = "SSH into the server"
  value       = "ssh ubuntu@${aws_eip.bender.public_ip}"
}
